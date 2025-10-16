/*  This is a load balancer script for Shelly Plugs written in Shelly Script.
    Shelly Script is an implementation of Espruino, a subset of Javascript for embedded devices.
    This script runs on multiple smart plugs with different priority levels, 
    preventing the circuit from being overloaded by deprioritizing low-priority plugs.
    Caution: High-current loads through consumer-grade smart plugs can damage them over time!
             It happened to me with a 12-amp 120-volt load with minimal cyclings!
    Notes:
    - All "print" statements are console.log(), regardless of log level, due to Espruino limitations
    - Espruino has no threading, and interrupts will wait for the previous interrupt to finish, 
      so no thread safety is needed
*/
export const name = "shellyloadbalancer"; // Make available as ES module, for testing with Jest
console.log("Starting power load balancer script");

/*  Constants
    Watts are used because they are the primary measurement unit for Shelly plugs, 
    and allow consistent logic when there is fluctuating mains voltage.
*/
const significantWattsThreshold = 200; // Below the minimum power of a small, 5000 BTU air conditioner
const standbyWattsThreshold = 5;
const significantWattChange = 5; // Watts difference that is ignored
const minutesPowerHistory = 5;
const msWaitForInrushStabilization = 1000; // Can take up to 1 second for large inductive loads, like transformers, to stabilize
const ownPriority = 5; // See line 68 (TODO) for priorities
// User needs to include this plug's name in the following list of plug names
const knownPlugNames = ["misha-air-conditioner", "katherine-air-conditioner", "evse", "living-room-air-conditioner"] // Declared in script instead of KVS to avoid character limit

/*
    Caution: Device names should only contain alphanumerics and hyphens ([a-z0-9\-]+), NO SPACES!
    That allows device names to be identical to their mDNS URLs.  Never use the same name for 2 devices.
*/
//const deviceName = Shelly.getComponentConfig("System:device:name").replaceAll(" ", "-")
//console.log("DEBUG: The dectected device name is ", Shelly.getComponentConfig("System:device:name"), " which has been simplified to ", deviceName)
export const circuitLimitWatts = 0.8*20*110; // Circuit is limited to 80% of breaker rating (20 amps) at mains voltage (pessimistically at 110 volts)
const minPriority = 5;
const commonUsername = "peppermint";
const commonPassword = "Sysssadm1n!"; // Plugs will be behind firewall, so this is relatively safe

var needToUpdateOtherPlugs = false;
var isLeader = true;
var expectedInrushUpdateTime = new Date();
var inrushTimeoutID = null;

function exceedsThreshold(compareValue) {
    return compareValue > significantWattsThreshold;
}

export var plugDevicesByName = new Map(); // Map of plug names and their properties
export var plugDevicesByPriority = new Array(); // Array of Arrays of names, with longest active plug first and longest inactive plug last
var selfPlug = null;
export function updatePlugsByOnTime() {
    // Go through each priority's sublist and sort it
    plugDevicesByPriority.forEach((nameList) => {
        nameList.sort(plugComparatorByName);
    });
};

function buildPlugURL(plugName, path){
    return "http://" + plugName + ".local/" + path;
}

export function createPlug(plugName, timeLastSeen, presentPowerConsumption, powerPriority, isCircuitClosed, isSelf) {
    let newPlug = {
        plugName: plugName,
        timeLastSeen: timeLastSeen,
        timeFirstSeen: timeLastSeen,
        /* A recent history of power consumptions at given times, up to minutesPowerHistory.
           Should be in chronological order since plugs only send their own updates, 
           and an update-sender should block further execution. 
        */
        powerConsumption: new Map([timeLastSeen, presentPowerConsumption]),
        timeLastUpdated: timeLastSeen,
        averageRecentConsumption: presentPowerConsumption,
        greaterConsumption: presentPowerConsumption, // The highest recent consumption (averaged values or most recent value)
        powerPriority: powerPriority, /* Lower number is higher priority.
        0 is critical to life (oxygen concentrator), 1 is critical to property (refrigerator), 
        2 is useful (lighting/tools/appliances/desktop computer), 3 is general-purpose (laptop charger/air conditioner in occupied room), 
        4 is low priority (heated blanket/air conditioner in unoccupied room), 5 is minimum priority (vehicle chargers) */
        timeLastCrossedThreshold: timeLastSeen,
        highestConsumption: presentPowerConsumption, // Greatest value ever seen during this period turned on, and recent peak when turned off
        isSelf: isSelf,
        isCircuitClosed: isCircuitClosed,
        currentlyExceedsThreshold () {
            return exceedsThreshold(averageRecentConsumption);
        },
        updatePower (time, newPower) {
            if(Math.abs(newPower - this.powerConsumption[this.timeLastUpdated]) < significantWattChange){
                return;
            }
            if(time <= this.timeLastUpdated){
                // If requests are processed out of order somehow, ignore older updates
                console.log("WARNING: Somehow a power update for plug", this.plugName, "was received at", time, "after an update was already received at", time.timeLastUpdated);
                return;
            }
            if(exceedsThreshold(newPower) != this.currentlyExceedsThreshold()){
                this.timeLastCrossedThreshold = time;
            }
            if(newPower > this.highestConsumption){
                this.highestConsumption = newPower;
            }
            timeLastSeen = time;

            this.powerConsumption.set(time, newPower);
            // Prune consumption history outside of window
            let timeCutoff = new Date(new Date() - minutesPowerHistory*60*1000);
            for (const [time, consumption] of this.powerConsumption) {
                if (time < timeCutoff){
                    this.powerConsumption.delete(time);
                }else{
                    // All further times are within the history window
                    break;
                }
            }
            this.timeLastUpdated = time;

            this.refreshRecentConsumption();
            updatePlugsByOnTime();
        },
        setPower (powerStatus) {
            // TODO: don't use HTTP to toggle self
            let desiredStatus = powerStatus ? "on" : "off";
            console.log("Toggling plug", this.plugName, "to", desiredStatus);
            // Shelly.call("Switch.Set", {id: 0, on: powerStatus});
            // TODO: include credentials here
            let response = Shelly.call("HTTP", {url: buildPlugURL(this.plugName, "relay/0?turn="+desiredStatus), timeout: 2});
            // TODO: Check response and retry if error, see https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/#http-endpoint-relayid
            // TODO: Verify status was updated within a few seconds, aborting verification if switch is quickly toggled a second time to the original state
        },
        updatePriority (newPriority) {
            if (newPriority == this.powerPriority){
                return;
            }
            let oldPriority = this.powerPriority;
            this.powerPriority = newPriority;
            plugDevicesByPriority[newPriority].push(this.plugName);
            let targetIndex = plugDevicesByPriority[this.oldPriority].findIndex((testPlug) => testPlug.plugName == this.plugName)
            plugDevicesByPriority[oldPriority].splice(targetIndex);

            updatePlugsByOnTime(); // Sort this plug into the new priority list
        },
        /*  Averages power consumption, weighted with exponential decay by minutes, perhaps 1/(2^(x+1)).  
            Total with a Riemann sum (rectangles to the right of the decreasing weight curve).
            Weights will not exactly add to 1.0 , so divide by sum of weights to compensate.  
            Cannot use Exponential Moving Average due to inconsistent reporting periods.  
        */
        refreshRecentConsumption () {
            let lastTime = null;
            let runningTotal = 0;
            let weightTotal = 0;
            for (const [time, consumption] of this.powerConsumption){
                if(lastTime != null){
                    let minutesAgo = (new Date() - time)/1000;
                    let minutesPeriod = (time - lastTime)/1000;
                    let weight = Math.pow(2, minutesAgo + 1);
                    weightTotal += weight;
                    runningTotal += (consumption * minutesPeriod / weight);
                }
                lastTime = time;
            }
            this.averageRecentConsumption = runningTotal / weightTotal;
            this.greaterConsumption = Math.max(this.averageRecentConsumption, this.powerConsumption[this.timeLastUpdated]);
            return this.averageRecentConsumption;
        },
        updateCircuitClosed(newCircuitStatus){
            if(newCircuitStatus == false){
                this.highestConsumption = this.greaterConsumption;
            }
            this.isCircuitClosed = newCircuitStatus;
            // Reset recent history since the average would otherwise be difficult to use
            // New power value must be immediately added or exceptions may occur from invalid values
            this.powerConsumption = new Map();
            this.timeLastUpdated = null;
            this.greaterConsumption = NaN;
            this.highestConsumption = NaN; // Reset highest consumption record with every circuit cycle
        }
    };
    plugDevicesByName.set(plugName, newPlug);
    plugDevicesByPriority[powerPriority].push(plugName);
    updatePlugsByOnTime();
    if(isSelf){
        selfPlug = newPlug;
    }
    return newPlug;
};

// Compares plugs for sorting.  Assumes all plugs are the same priority.  
function plugComparatorByName(name1, name2){
    let plug1 = plugDevicesByName.get(name1);
    let plug2 = plugDevicesByName.get(name2);

    function determinePlugConsumptionTier(plug){
        // Significant load > insignificant load > open circuit (should be <1 watt)
        if(plug.currentlyExceedsThreshold()){
            return 2;
        }else if (plug.isCircuitClosed){
            return 1;
        }else{
            return 0;
        }
    };

    let plug1ConsumptionTier = determinePlugConsumptionTier(plug1);
    let plug2ConsumptionTier = determinePlugConsumptionTier(plug2);

    if (plug1ConsumptionTier == plug2ConsumptionTier){
        // Within each tier, sort by longest time since toggle, e.g.
        // On for long time > on for short time > off for long time > off for short time
        return (plug1.timeLastCrossedThreshold - plug2.timeLastCrossedThreshold);
    } else {
        return (plug1ConsumptionTier - plug2ConsumptionTier);
    }
};

/*  
    Determines plugs to disable (shed) or to reenable, 
    allowing us to keep the circuit as close to its maximum as possible.
    A lock is not necessary because Espruino should allow functions to finish before handling a new event.
*/
function rebalancePlugs(wattsToAdd){
    console.log("DEBUG: Rebalancing circuit with spare capacity of", wattsToAdd, "watts")
    let remainingWatts = Math.abs(wattsToAdd);
    let plugNamesToToggle = new Array();
    let desiredPlugStatus = (wattsToAdd > 0); // Will be false if shedding, since plugs will be turned off
    
    /*
        Try to keep highest priority plugs powered on.
        So when shedding, drop lowest priority plugs first.
        And when reenabling, start with highest priority plugs first.
    */
    let priorityLevel = desiredPlugStatus ? 0 : plugDevicesByPriority.length - 1;
    let priorityChangePerLoop = desiredPlugStatus ? 1 : -1;
    for(; priorityLevel >= 0 && priorityLevel < plugDevicesByPriority.length; priorityLevel+=priorityChangePerLoop) {
        let plugList = plugDevicesByPriority[priorityLevel];
        if (plugList === undefined){
            // No plugs at this priority level
            continue;
        }
        for(const currentPlugName of plugList){
            let currentPlug = plugDevicesByName.get(currentPlugName);
            if (!desiredPlugStatus){ // Shedding plugs, so look at present current consumption
                if (currentPlug.isCircuitClosed) {
                    remainingWatts -= currentPlug.greaterConsumption;
                    plugNamesToToggle.unshift(currentPlugName);
                    console.log("DEBUG: Considering dropping", currentPlugName, "with", currentPlug.greaterConsumption, "watts of recent peak consumption. ", remainingWatts, "watts remaining.");
                }
                if (remainingWatts <= 0) {
                    break;
                }
            } else { // Reenabling plugs, so try to power everything in this priority tier first before continuing down.  Use maximum current consumption to avoid overloading circuit in a few seconds.
                if(currentPlug.isCircuitClosed && currentPlug.greaterConsumption <= remainingWatts){
                    remainingWatts -= currentPlug.highestConsumption;
                    plugNamesToToggle.push(currentPlugName);
                    console.log("DEBUG: Will reenable", currentPlugName, "with", currentPlug.greaterConsumption, "watts of recent peak consumption. ", remainingWatts, "watts remaining.");
                }
            }
        }
        if (!desiredPlugStatus && remainingWatts <= 0) {
            break;
        }
        // Don't break early when reenabling plugs, as another smaller load could also be reenabled
    }

    /* 
        If dropping plugs, we are now under the circuit capacity.
        The most recent plug candidate might have dropped more load than necessary, 
        so check if there are small loads to keep online.
        The first loop iteration will never add back the last plug, but the loop is more readable this way.
        When reenabling plugs, we stop before going over capacity
        (and don't want to drop a higher priority plug that is further down the list), so this pass is skipped.
    */
    if(!desiredPlugStatus){
        for (const currentPlugName of plugNamesToToggle) {
            let currentPlug = plugDevicesByName.get(currentPlugName);
            if (currentPlug.greaterConsumption < -remainingWatts) {
                plugNamesToToggle.splice(plugNamesToToggle.indexOf(currentPlugName, 1));
                remainingWatts += currentPlug.greaterConsumption;
                console.log("DEBUG: No need to drop", currentPlugName, remainingWatts, "remaining");
            }
        }
    }

    // Toggle plugs
    for (const plugName of plugNamesToToggle) {
        plugDevicesByName.get(plugName).setPower(desiredPlugStatus);
    }
}

export function verifyCircuitLoad() {
    console.log("DEBUG: Checking circuit load")

    let remainingWatts = circuitLimitWatts;
    for (const [plugName, plug] of plugDevicesByName){
        remainingWatts -= plug.greaterConsumption;
    }

    console.log("DEBUG: Circuit has spare capacity of", remainingWatts, "watts from a total of", circuitLimitWatts, "calculated from recent peak values");

    if (remainingWatts < 0) {
        rebalancePlugs(remainingWatts);
    }
    console.log("DEBUG: Finished checking circuit load");
}

function decodeParam(params, paramName, type, minValue, maxValue){
    // Get starting and ending character of parameter's value
    let startIndex = params.indexOf(paramName + "=") + paramName.length + 1;
    if(startIndex == -1){
        return null;
    }
    let endIndex = params.indexOf("&", startIndex);
    if(endIndex >= 0){
        var textValue = params.substring(startIndex, endIndex);
    }else{ // Assume this is the final parameter
        var textValue = params.substring(startIndex);
    }
    
    // Parse the parameter
    if (type == "number") {
        let parsedValue = Number(textValue);
        if (parsedValue === NaN || 
            // Actual number parsed, validate range if needed
            ((minValue == null || parsedValue >= minValue) && 
                (maxValue == null || parsedValue <= maxValue))){
            return parsedValue;
        } else {
            throw new Error("Error parsing integer", textValue, "for parameter", paramName, "with minimum", minValue, "and maximum", maxValue);
        }
    } else if (type == "string") {
        return textValue;
    } else if (type == "boolean") {
        if(textValue.length === 0 || !(textValue === "true" || textValue === "false")){
            throw new Error("Could not parse boolean", textValue, "for parameter", paramName);
        }
        return textValue === "true";
    } else {
        throw new Error("Cannot parse type", type, "for name", paramName);
    }
}

export function updatePlug(request, response, _userdata) {
    // Decode request parameters
    let params = request.query;
    let receivedTime = new Date(); // Use internal clock for everything to avoid syncing clocks between devices
    console.log("DEBUG: Processing plug update request", params, "at time", receivedTime);
    try {
        let senderName = decodeParam(params, "sender", "string", null, null);
        let newPowerValue = decodeParam(params, "value", "number", 0, null);
        let newCircuitStatus = decodeParam(params, "circuitclosed", "boolean", null, null);
        let senderPriority = decodeParam(params, "priority", "number", 0, minPriority);
        console.log("DEBUG: Params are", senderName, newPowerValue, newCircuitStatus, senderPriority);

        // Process parameters, responding with "bad request" if params are not as expected
        response.code = 200;
        if (senderName == null) {
            // Can't parse report that has no plug name
            response.code = 400;
        } else if (!plugDevicesByName.has(senderName)){
            // New plug
            createPlug(senderName, receivedTime, newPowerValue, senderPriority, newCircuitValue, false);
        } else {
            // Update existing plug with provided parameters
            let senderObj = plugDevicesByName.get(senderName);
        
            if(newCircuitStatus !== null){ // Update circuit status and greatest consumption history, before it is updated with off-values
                senderObj.updateCircuitClosed(newCircuitStatus);
            }
            if(newPowerValue !== null && !isNaN(newPowerValue)){
                senderObj.updatePower(receivedTime, newPowerValue);
            }
            if(senderPriority !== null && !isNaN(senderPriority)){
                senderObj.updatePriority(senderPriority);
            }
        }
    } catch (error) {
        console.log("ERROR: While parsing request", params, "got error message", error)
        response.code = 400;
    }

    if (!response.send()){
        console.log("Failed to send response for request", params, "with status", response.code);
    }else{
        console.log("DEBUG: Finished sending response for request", params, "with status", response.code);
    }

    if(isLeader){
        verifyCircuitLoad();
    }
}

// Called by host runtime when there is a status update for this plug
function statusUpdateHandler(status){
    if(status.component !== "switch:0"){ // TODO: Verify this is the correct status format
        console.log("DEBUG: Ignoring status update because it was for", status.component)
        return;
    }
    let receivedTime = new Date();
    selfPlug.updateCircuitClosed(status.output);

    // Power has just begun increasing so we need to wait for inrush to settle
    if(status.apower > selfPlug.powerConsumption[selfPlug.timeLastUpdated] && expectedInrushUpdateTime === null){
        expectedInrushUpdateTime = new Date(receivedTime.getTime() + msWaitForInrushStabilization);
        console.log("DEBUG: Waiting out inrush until", expectedInrushUpdateTime);
        setTimeout(function(){
            console.log("DEBUG: Inrush imeout triggered at", new Date());
            this(Shelly.getComponentStatus("switch", 0));
        }, msWaitForInrushStabilization);
    }
    // Power is decreasing, or done waiting for inrush, so update can be triggered
    else if(status.apower <= selfPlug.powerConsumption[selfPlug.timeLastUpdated] || receivedTime >= expectedInrushUpdateTime){
        console.log("DEBUG: Updating power at", receivedTime);
        selfPlug.updatePower(new Date(), status.apower);
        clearTimeout(inrushTimeoutID);
        expectedInrushUpdateTime = null;
        inrushTimeoutID = null;
    }
    // Still waiting for inrush to stabilize; ignore this update
    else {
        console.log("DEBUG: Ignoring power update at", receivedTime);
        return;
    }
    
    // TODO: Need to send updates in a timely fashion, so block and send (as there is no parallel execution)
}

var statusListener = Shelly.addStatusHandler(statusUpdateHandler);
console.log("DEBUG: Registered internal status listener");

var updateHandlerURL = HTTPServer.registerEndpoint("updatePlug", updatePlug);
console.log("DEBUG: Registered plug update handler at", updateHandlerURL);
// Full URL will look like: http://Shelly-Plug.local/script/1/updatePlug?sender=OtherPlug&value=100&&circuitclosed=true&priority=1&startup=false
// Each plug should update all plugs including itself
// This script should be the first script on each plug so that URL's script ID is consistent
// TODO: All updates should wait 1 second for inrush current to stabilize, especially for large transformers (like in cheap microwaves)
// TODO: Sending updates every 10 seconds as a heartbeat, so that offline plugs can be pruned from list
// TODO: Send updates to other plugs from this script, instead of via Shelly webhooks
// TODO: Send "hello" to other plugs upon startup, so they can reset their statistics, and add self to plug list.  
// TODO: When hello is received, reset plug statistics and resend own statistics.  
// TODO: Periodically check needToUpdateOtherPlugs.  For self, replace domain with 127.0.0.1.  
// TODO: If plug cannot communicate, open its circuit


/*  TODO: Make a system where plugs will decide which becomes the leader by longest time online.
    A leader plug that has been offline for 25 seconds (two check-in periods) is "voted out".
    Any plug can send a "voting motion" with a uniqute voting UID to the other plugs, 
    which triggers all to evalute the voting scenario. Each plug sends its vote to all the others, 
    then all plugs tally the votes and send their tally to the others.  If any plug detects a tally mismatch, 
    it sends a mismatch signal to the others, which rebroadcast it.  Then the vote is redone, 
    with a decreasing retry count until a fallback scenario is reached.  

*/
export function processVoteRequest(request, response, userdata) {
    let params = request.query;
    let receivedTime = new Date();
    console.log("DEBUG: Processing vote request", params, "at time", receivedTime);
    // TODO
}
var voteHandlerURL = HTTPServer.registerEndpoint("voteRequest", processVoteRequest);
console.log("Registered vote request handler at", voteHandlerURL);

// TODO: Espruino 2v13 and earlier treats "let" as "var"; verify version/behavior and adjust this script accordingly
let testVariable = "outside";
if (true) {
    let testVariable = "inside";
}
console.log("DEBUG: using keyword let will presist", testVariable);
