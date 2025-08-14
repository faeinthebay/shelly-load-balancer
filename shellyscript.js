/*  This is a load balancer script for Shelly Plugs written in Shelly Script.
    Shelly Script is an implementation of Espruino, a subset of Javascript for embedded devices.
    This script runs on multiple smart plugs with different priority levels, 
    disabling plugs with lower priorities when the circuit is being overloaded.
*/
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
export let plugDevicesByName = new Map(); // TODO: Verify this still works instead of const = {}
export let plugDevicesByPriority = new Array(); // Array of Arrays of names, with longest active plug first and longest inactive plug last
export function updatePlugsByOnTime() {
    // Go through each priority's sublist and sort it
    plugDevicesByPriority.forEach((nameList) => {
        nameList.sort(plugComparator);
    });
};

const isLeader = true; // TODO: Track which plug is first online and make it the "leader" while other plugs are the "followers"

export function createPlug(plugName, timeLastSeen, powerConsumption, powerPriority) {
  let newPlug = {
    plugName: plugName,
    timeLastSeen: timeLastSeen,
    powerConsumption: powerConsumption,
    powerPriority: powerPriority, /* Lower number is higher priority.  Cannot be changed after plug created.  
    0 is critical to life (oxygen concentrator), 1 is critical to property (refrigerator), 
    2 is useful (lighting and tools), 3 is general-purpose, 
    4 is low priority, 5 is minimum priority (vehicle chargers) */
    timeLastCrossedThreshold: timeLastSeen,
    highestConsumption: powerConsumption, // TODO: Allow plugs to declare varible load (like an inverter A/C or multi-step heater), so this variable can be ignored, hard-coded, or slowly fall to a current value if that value is above the "significant load" threshold
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
        // TODO: Make this async, or use a tight timeout
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

    function determinePlugConsumptionTier(plug){
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

    let plug1ConsumptionTier = determinePlugConsumptionTier(plug1);
    let plug2ConsumptionTier = determinePlugConsumptionTier(plug2);

    if (plug1ConsumptionTier == plug2ConsumptionTier){
        // Within each tier, sort by longest time since toggle
        return (plug1.timeLastCrossedThreshold - plug2.timeLastCrossedThreshold);
    } else {
        return (plug1ConsumptionTier - plug2ConsumptionTier);
    }
};

/*  Determines plugs to disable or reenable to keep the circuit as close to its maximum as possible.
    A lock is not necessary because Espruino should allow functions to finish before handling a new event
*/
function rebalancePlugs(wattsToAdd){
    let remainingWatts = Math.abs(wattsToAdd);
    let plugNamesToToggle = new Array();
    let desiredPlugStatus = (wattsToAdd > 0); // Will be false if shedding, since plugs will be turned off
    
    // Try to keep highest priority plugs powered on, so when shedding, start at lowest priority
    let priorityLevel = desiredPlugStatus ? 0 : plugDevicesByPriority.length - 1;
    let priorityChangePerLoop = desiredPlugStatus ? 1 : -1;
    for(; priorityLevel >= 0 && priorityLevel < plugDevicesByPriority.length; priorityLevel+=priorityChangePerLoop) {
        let plugList = plugDevicesByName[priorityLevel];
        if (plugList === undefined){
            // No plugs at this priority level
            continue;
        }
        for(const currentPlugName of plugList){
            // TODO: Rewrite this for-loop to handle reenabling plugs, since we need to compare each plug's maximum consumption, and will skip adding any plugs that go over the limit.
            let currentPlug = plugDevicesByName[currentPlugName];
            if (currentPlug.isLoaded()) {
                remainingWatts -= currentPlug.powerConsumption;
                plugNamesToToggle.unshift(currentPlugName);
            }
            if (remainingWatts <= 0) {
                break;
            }
        }
        if (remainingWatts <= 0) {
            break;
        }
    }

    /* Keep plugs online/offline if there is spare capacity to add back.
       The first iteration will never add back the most recent plug, but the code is more readable this way.
    */
    // TODO: Skip this if reenabling plugs since we don't want to consider passing over a large high-priority load to reenable a small low-priority load  
    for (const currentPlugName of plugNamesToToggle) {
        let currentPlug = plugDevicesByName[currentPlugName];
        if (currentPlug.highestConsumption < -remainingWatts) {
            plugNamesToToggle.splice(plugIndex, 1);
            remainingWatts += currentPlug.highestConsumption;
        }
    }

    // Toggle plugs
    for (const plugName of plugNamesToToggle) {
        console.log("Toggling plug", plugName, "to", desiredPlugStatus);
        plugDevicesByName[plugName].setPower(desiredPlugStatus);
    }
} 

export function verifyCircuitLoad() {
    let plugsToDrop = []
    /* Calculate total load, and remove longest-running significant consumption from that load
       until total is under threshold.  */
    console.log("DEBUG: Checking circuit load")

    let remainingWatts = circuitLimitWatts;
    for (const [plugName, plug] of plugDevicesByName){
        remainingWatts -= plug.powerConsumption;
    }

    console.log("DEBUG: Circuit has spare capacity of", remainingWatts, "watts from a total of", circuitLimitWatts);

    if (remainingWatts < 0) {
        rebalancePlugs(remainingWatts);
    }}

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
    } else {
        response.code = 200;
    }

    if (!response.send()){
        console.log("Failed to send response for request", params, "with status", response.code);
    }else{
        console.log("DEBUG: Sent response for request", params, "with status", response.code);
    }

    // TODO: Update or create corresponding plug object with new values
    // TODO: Panic if plug has load of more than 5 watts but is toggled off
    // TODO: Update from map to nested arrays
    /*if (!plugDevicesByName.has(senderName)){
        createPlug(senderName, receivedTime, newPowerValue, senderPriority)
    } else {
        plugDevicesByName.get(senderName).updatePower(receivedTime, newPowerValue)
    }*/

    if(isLeader){
        verifyCircuitLoad();
    }
}

let powerHandlerURL = HTTPServer.registerEndpoint("updatePlugPower", updatePlugPower);
// Full URL will look like: http://Shelly-Plug.local/script/1/updatePlugPower?sender=OtherPlug&value=100&priority=1
// Each plug should update all plugs including itself, and all updates should wait 1 second for inrush current to stabilize
// TODO: Consider sending updates ever minute as a heartbeat, so that offline plugs can be pruned from list

console.log("Registered power update handler at", powerHandlerURL);
// TODO: Do I need to query other devices' Shelly Scripting local APIs for the script ID, or is it predicatable?
