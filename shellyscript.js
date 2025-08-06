export const name = "shellyloadbalancer" // ES module only needed for testing with Jest
const scriptVersion = 1
// TODO: Check script version on other devices
console.log("Starting power limiter script version", scriptVersion)

// Constants
const significantWattsThreshold = 200 // Below the minimum power of a small, 5000 BTU air conditioner
function exceedsThreshold(compareValue) {
    return compareValue > significantWattsThreshold
}
// TODO: Find a way to get hostname or replicate transforming device name into hostname
// Caution: This script uses device names as UIDs; two devices with same name will be seen as one device to this script
//const deviceName = Shelly.getComponentConfig("System:device:name").replaceAll(" ", "-")
//console.log("DEBUG: The dectected device name is ", Shelly.getComponentConfig("System:device:name"), " which has been simplified to ", deviceName)
export const circuitLimitWatts = 0.8*20*110 // Circuit is limited to 80% of breaker rating (20 amps) at mains voltage (pessimistically at 110 volts)

// Map of other plugs' names and their properties
// This should be okay since typical JS environments are single-threaded
export let plugDevicesByName = new Map(); // TODO: Verify this still works instead of const = {}
export let plugDevicesByPriority = new Array(); // Array of Arrays of names
export function updatePlugsByOnTime() {
    // Go through each priority's sublist and sort it so the longest-running plugs are first
    plugDevicesByPriority.forEach((nameList) => {
        nameList.sort(plugConsumptionCompareByName)
    });
};
export function createPlug(plugName, timeLastSeen, powerConsumption, powerPriority) {
  let newPlug = {
    plugName: plugName,
    timeLastSeen: timeLastSeen,
    powerConsumption: powerConsumption,
    powerPriority: powerPriority, // Lower number is higher priority.  0 is critical to life (oxygen concentrator), 1 is critical to property (refrigerator), 2 is useful (lighting and tools), 3 is general-purpose, 4 is low priority, 5 is minimum priority (vehicle chargers)
    timeLastCrossedThreshold: timeLastSeen,
    currentlyExceedsThreshold () {
        return exceedsThreshold(powerConsumption)
    },
    updatePower (time, newPower) {
        if(exceedsThreshold(newPower) != this.currentlyExceedsThreshold()){
            this.timeLastCrossedThreshold = time
        }
        timeLastSeen = time
        powerConsumption = newPower
        // TODO: Also update plugDevicesByName
    }
  };
  plugDevicesByName.set(plugName, newPlug);
  plugDevicesByPriority[powerPriority].push(plugName); // TODO: Insert in correct position
};
function plugConsumptionCompareByName(name1, name2){
    plug1consumption = plugDevicesByName[name1].powerConsumption
    plug2consumption = plugDevicesByName[name2].powerConsumption
    return (plug1consumption - plug2consumption)
};

export function verifyCircuitLoad() {
    let plugsToDrop = []
    /* Calculate total load, and remove longest-running significant consumption from that load
       until total is under threshold.  */
    // TODO: Consider priority
    console.log("DEBUG: Checking circuit load")

    do {
        let totalWatts = 0
        let oldestPlugName = null
        let oldestPlugUpdate = Date()

        for (const [plugName, plugData] of plugDevicesByName) {
            if (! plugName in plugsToDrop){
                totalWatts += plugData.powerConsumption

                if (plugData.timeLastSeen < oldestPlugUpdate && plugData.exceedsThreshold()){
                    oldestPlugName = plugName
                    oldestPlugUpdate = plugData.timeLastSeen
                }
            }
        }

        if (exceedsThreshold(totalWatts)) {
            if (oldestPlugName == null){
                console.log("ERROR: Cannot drop any more plugs even though consumption exceeds limit of", circuitLimitWatts, "; turning off other outlets")
                break
            }
            plugsToDrop.append(oldestPlugName)
        }
    } while (totalWatts > circuitLimitWatts)

    // Turn off plugs over the consumption limit
    for (plugToDrop of plugsToDrop) {
        // TODO: Enter consensus with other plugs, then send after 5 seconds
        console.log("DEBUG: would be dropping plug", plugName)
    }

    // TODO: Turn on disabled plugs, from lowest to highest, until limit is met
}

function decodeParam(params, paramName, isNumber){
    let startIndex = params.indexOf(paramName + "=") + paramName.length + 1
    let endIndex = params.indexOf("&", startIndex)
    if(endIndex >= 0){
        var textValue = params.substring(startIndex, endIndex)
    }else{
        var textValue = params.substring(startIndex)
    }
    
    if (isNumber) {
        return Number(textValue)
    } else {
        return textValue
    }
}

export function updatePlugPower(request, response, userdata) {
    // Decode request parameters
    let params = request.query
    let receivedTime = Date()
    console.log("DEBUG: Processing request", params, "at time", receivedTime)
    let senderName = decodeParam(params, "sender", false)
    let newPowerValue = decodeParam(params, "value", true)
    let senderPriority = decodeParam(params, "priority", true)
    console.log("DEBUG: Params are", senderName, newPowerValue, senderPriority)

    // Respond with "bad request" error if params are not as expected
    if (senderName == null || isNaN(newPowerValue) || isNaN(senderPriority)) {
        response.code = 400
        if (!response.send()){
            console.log("Failed to send 400 response for request", params)
        }
        console.log("DEBUG: Issue decoding params")
        return
    }else{
        console.log("DEBUG: Params decoded without issue")
    }

    // Update or create corresponding plug object with new values
    // TODO: Update from map to nested arrays
    /*if (!plugDevicesByName.has(senderName)){
        createPlug(senderName, receivedTime, newPowerValue, senderPriority)
    } else {
        plugDevicesByName.get(senderName).updatePower(receivedTime, newPowerValue)
    }*/

    // Since there were no errors while decoding data, acknowledge request
    response.code = 200
    if (!response.send()){
        console.log("Failed to send 200 response for request", request.query)
    } else {
        console.log("Sent 200 response for request", request.query) 
    }

    // TODO verifyCircuitLoad()
}

let powerHandlerURL = HTTPServer.registerEndpoint("updatePlugPower", updatePlugPower)
// Full URL will look like: http://Shelly-Plug.local/script/1/updatePlugPower?sender=OtherPlug&value=100&priority=1
// Each plug should update all plugs including itself, and all updates should wait 1 second for inrush current to stabilize
// TODO: Consider sending updates ever minute as a heartbeat, so that offline plugs can be pruned from list

console.log("Registered power update handler at", powerHandlerURL)
// TODO: Do I need to query other devices' Shelly Scripting local APIs for the script ID, or is it predicatable?
