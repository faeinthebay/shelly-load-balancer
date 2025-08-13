export const name = "shellyloadbalancer"; // ES module only needed for testing with Jest
console.log("Starting power limiter script");

// Constants
const significantWattsThreshold = 200; // Below the minimum power of a small, 5000 BTU air conditioner
const standbyWattsThreshold = 5;
function exceedsThreshold(compareValue) {
    return compareValue > significantWattsThreshold;
}
// TODO: Find a way to get hostname or replicate transforming device name into hostname
// Caution: This script uses device names as UIDs; two devices with same name will be seen as one device to this script
//const deviceName = Shelly.getComponentConfig("System:device:name").replaceAll(" ", "-")
//console.log("DEBUG: The dectected device name is ", Shelly.getComponentConfig("System:device:name"), " which has been simplified to ", deviceName)
export const circuitLimitWatts = 0.8*20*110; // Circuit is limited to 80% of breaker rating (20 amps) at mains voltage (pessimistically at 110 volts)
const minPriority = 5;

// Map of other plugs' names and their properties
// JS environments are single-threaded, so thread safety should not be needed
export let plugDevicesByName = new Map(); // TODO: Verify this still works instead of const = {}
export let plugDevicesByPriority = new Array(); // Array of Arrays of names, with longest active plug first and longest inactive plug last
export function updatePlugsByOnTime() {
    // Go through each priority's sublist and sort it
    plugDevicesByPriority.forEach((nameList) => {
        nameList.sort(plugComparator);
    });
};

export function createPlug(plugName, timeLastSeen, powerConsumption, powerPriority) {
  let newPlug = {
    plugName: plugName,
    timeLastSeen: timeLastSeen,
    powerConsumption: powerConsumption,
    powerPriority: powerPriority, /* Lower number is higher priority.  
    0 is critical to life (oxygen concentrator), 1 is critical to property (refrigerator), 
    2 is useful (lighting and tools), 3 is general-purpose, 
    4 is low priority, 5 is minimum priority (vehicle chargers) */
    timeLastCrossedThreshold: timeLastSeen,
    highestConsumption: powerConsumption,
    currentlyExceedsThreshold () {
        return exceedsThreshold(powerConsumption);
    },
    isLoaded () {
        return powerConsumption > standbyWattsThreshold;
    },
    updatePower (time, newPower) {
        if(exceedsThreshold(newPower) != this.currentlyExceedsThreshold()){
            this.timeLastCrossedThreshold = time;
        }
        if(newPower > this.highestConsumption){
            this.highestConsumption = newPower;
        }
        timeLastSeen = time;
        powerConsumption = newPower;
        updatePlugsByOnTime();
    },
    setPower (powerStatus) {
        // TODO: Turn plug on or off here
        return;
    }
  };
  plugDevicesByName.set(plugName, newPlug);
  plugDevicesByPriority[powerPriority].push(plugName);
  updatePlugsByOnTime();
  return newPlug;
};

function plugComparator(name1, name2){
    let plug1 = plugDevicesByName[name1];
    let plug2 = plugDevicesByName[name2];

    function getPlugConsumptionTier(plug){
        // Significant load > insignificant load > no load
        if(plug.currentlyExceedsThreshold()){
            return 2;
        }
        else if(plug.isLoaded){
            return 1;
        }else{
            return 0;
        }
    };

    let plug1ConsumptionTier = getPlugConsumptionTier(plug1);
    let plug2ConsumptionTier = getPlugConsumptionTier(plug2);

    if (plug1ConsumptionTier == plug2ConsumptionTier){
        // Within each tier, sort by longest time since toggle
        return (plug1.timeLastCrossedThreshold - plug2.timeLastCrossedThreshold);
    } else {
        return (plug1ConsumptionTier - plug2ConsumptionTier);
    }
    
    /*
    // A plug with significant consumption is always greater than a plug with insignificant consumption
    if (plug1.currentlyExceedsThreshold() == plug2.currentlyExceedsThreshold()){
        return (plug1.timeLastCrossedThreshold.getTime() - plug2.timeLastCrossedThreshol.getTime());
    } else if (plug1.currentlyExceedsThreshold()){
        return 1;
    } else {
        return -1;
    }
        */
};

function prunePlugs(wattsToPrune){
    let remainingWatts = wattsToPrune;
    let plugNamesToPrune = new Array();
    
    // Prune lowest priority, lowst consumption plugs first
    // TODO: Instead, prune lowest priority and longest running plugs
    for(let priorityLevel = plugDevicesByPriority.length - 1; priorityLevel >= 0; priorityLevel--) {
        let plugList = plugDevicesByName[priorityLevel];
        if (plugList === undefined){
            // No plugs at this priority level
            continue;
        }
        for(let plugIndex = plugList.length - 1; plugIndex >= 0; plugIndex--){
            let currentPlugName = plugList[plugIndex];
            let currentPlug = plugDevicesByName[currentPlugName];
            if (currentPlug.isLoaded()) {
                remainingWatts -= currentPlug.powerConsumption;
                plugNamesToPrune.push(currentPlugName);
            }
            if (remainingWatts <= 0) {
                break;
            }
        }
        if (remainingWatts <= 0) {
            break;
        }
    }
    // Add back plugs if there's spare capacity
    // TODO: Break this out so it can reused for enabling plugs arbitrarily
    // TODO: Instead of list order, add back plugs that have been waiting for the longest time
    for (let plugIndex = 1; plugIndex < plugNamesToPrune.length; plugIndex++) {
        let currentPlug = plugDevicesByName[plugNamesToPrune[plugIndex]];
        if (currentPlug.highestConsumption < -remainingWatts) {
            plugNamesToPrune.splice(plugIndex, 1);
            remainingWatts += currentPlug.highestConsumption;
        }
    }

    for (const plugName of plugNamesToPrune) {
        plugDevicesByName[plugName].setPower(false);
    }
} 

export function verifyCircuitLoad() {
    let plugsToDrop = []
    /* Calculate total load, and remove longest-running significant consumption from that load
       until total is under threshold.  */
    // TODO: Consider priority
    console.log("DEBUG: Checking circuit load")

    let remainingWatts = circuitLimitWatts;
    for (const [plugName, plug] of plugDevicesByName){
        remainingWatts -= plug.powerConsumption;
    }

    // If limit is exceeded, prune plugs, lowest priority first 
    if (remainingWatts < 0) {
        prunePlugs(-remainingWatts);
    }

    // Turn off plugs over the consumption limit
    // TODO: Turn on disabled plugs, from lowest to highest, until limit is met
}

function decodeParam(params, paramName, isNumber){
    let startIndex = params.indexOf(paramName + "=") + paramName.length + 1;
    let endIndex = params.indexOf("&", startIndex);
    if(endIndex >= 0){
        var textValue = params.substring(startIndex, endIndex);
    }else{
        var textValue = params.substring(startIndex);
    }
    
    if (isNumber) {
        return Number(textValue);
    } else {
        return textValue;
    }
}

export function updatePlugPower(request, response, userdata) {
    // Decode request parameters
    let params = request.query;
    let receivedTime = Date();
    console.log("DEBUG: Processing request", params, "at time", receivedTime);
    let senderName = decodeParam(params, "sender", false);
    let newPowerValue = decodeParam(params, "value", true);
    let senderPriority = decodeParam(params, "priority", true);
    console.log("DEBUG: Params are", senderName, newPowerValue, senderPriority);

    // Respond with "bad request" error if params are not as expected
    if (senderName == null || isNaN(newPowerValue) || isNaN(senderPriority)) {
        response.code = 400;
        if (!response.send()){
            console.log("Failed to send 400 response for request", params);
        }
        console.log("DEBUG: Issue decoding params");
        return;
    }else{
        console.log("DEBUG: Params decoded without issue");
    }

    // Update or create corresponding plug object with new values
    // TODO: Update from map to nested arrays
    /*if (!plugDevicesByName.has(senderName)){
        createPlug(senderName, receivedTime, newPowerValue, senderPriority)
    } else {
        plugDevicesByName.get(senderName).updatePower(receivedTime, newPowerValue)
    }*/

    // Since there were no errors while decoding data, acknowledge request
    response.code = 200;
    if (!response.send()){
        console.log("ERROR: Failed to send 200 response for request", request.query);
    } else {
        console.log("DEBUG: Sent 200 response for request", request.query);
    }

    // TODO verifyCircuitLoad()
}

let powerHandlerURL = HTTPServer.registerEndpoint("updatePlugPower", updatePlugPower);
// Full URL will look like: http://Shelly-Plug.local/script/1/updatePlugPower?sender=OtherPlug&value=100&priority=1
// Each plug should update all plugs including itself, and all updates should wait 1 second for inrush current to stabilize
// TODO: Consider sending updates ever minute as a heartbeat, so that offline plugs can be pruned from list

console.log("Registered power update handler at", powerHandlerURL);
// TODO: Do I need to query other devices' Shelly Scripting local APIs for the script ID, or is it predicatable?
