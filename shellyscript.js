/*  This is a load balancer script for Shelly Plugs written in Shelly Script.
    Shelly Script is an implementation of Espruino, a subset of Javascript for embedded devices.
    This script runs on multiple smart plugs with different priority levels, 
    preventing the circuit is being overloaded and prioritizing high priority plugs.
    Caution: High-current loads through consumer-grade smart plugs can damage them over time!
             It happened to the dev with a 12-amp 120-volt load with minimal plug cycles!
*/
export const name = "shellyloadbalancer"; // Make available as ES module, for testing with Jest
console.log("Starting power load balancer script");
// TODO: Espruino 2v13 and earlier treats "let" as "var"; verify version and adjust this script accordingly

/*  Constants
    Watts are used because they are the primary measurement unit for Shelly plugs, 
    and allow consistent logic when there is fluctuating mains voltage.
*/
const significantWattsThreshold = 200; // Below the minimum power of a small, 5000 BTU air conditioner
const standbyWattsThreshold = 5;
const significantWattChange = 5; // Watts difference that is ignored
const minutesPowerHistory = 5;
function exceedsThreshold(compareValue) {
    return compareValue > significantWattsThreshold;
}
/*
    Caution: This script uses device names as UIDs, so two devices with same name
             will be seen as one device to this script.
    To be safe, name devices only with alphanumerics and hyphens ([a-z0-9\-]+), NO SPACES!
*/
//const deviceName = Shelly.getComponentConfig("System:device:name").replaceAll(" ", "-")
//console.log("DEBUG: The dectected device name is ", Shelly.getComponentConfig("System:device:name"), " which has been simplified to ", deviceName)
export const circuitLimitWatts = 0.8*20*110; // Circuit is limited to 80% of breaker rating (20 amps) at mains voltage (pessimistically at 110 volts)
const minPriority = 5;
const commonUsername = "peppermint";
const commonPassword = "Sysssadm1n!"; // Plugs will be behind firewall, so this is relatively safe

var needToUpdateOtherPlugs = false;
var isLeader = true;

// Map of plugs' mDNS names and their properties
export var plugDevicesByName = new Map();
export var plugDevicesByPriority = new Array(); // Array of Arrays of names, with longest active plug first and longest inactive plug last
// User needs to include this plug in  list of plug names
const knownPlugNames = ["misha-air-conditioner", "katherine-air-conditioner", "evse", "living-room-air-conditioner"] // Declared in script instead of KVS to avoid character limit
var selfPlug = null;
export function updatePlugsByOnTime() {
    // Go through each priority's sublist and sort it
    plugDevicesByPriority.forEach((nameList) => {
        nameList.sort(plugComparator);
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
        lastUpdated: timeLastSeen,
        averageRecentConsumption: NaN,
        powerPriority: powerPriority, /* Lower number is higher priority.
        0 is critical to life (oxygen concentrator), 1 is critical to property (refrigerator), 
        2 is useful (lighting/tools/appliances/desktop computer), 3 is general-purpose (laptop charger/air conditioner in occupied room), 
        4 is low priority (heated blanket/air conditioner in unoccupied room), 5 is minimum priority (vehicle chargers) */
        timeLastCrossedThreshold: timeLastSeen,
        highestConsumption: presentPowerConsumption,
        isSelf: isSelf,
        isCircuitClosed: isCircuitClosed,
        currentlyExceedsThreshold () {
            return exceedsThreshold(powerConsumption);
        },
        updatePower (time, newPower) {
            if(Math.abs(newPower - getRecentConsumption()) < 5){
                return;
            }
            if(exceedsThreshold(newPower) != this.currentlyExceedsThreshold()){
                this.timeLastCrossedThreshold = time;
            }
            if(newPower > this.highestConsumption){
                this.highestConsumption = newPower;
                // TODO: Reset highest consumption after 24 hours below significant threshold
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

            this.averageRecentConsumption();
            updatePlugsByOnTime();
        },
        setPower (powerStatus) {
            // TODO: don't use HTTP for self
            let desiredStatus = powerStatus ? "on" : "off";
            // Shelly.call("Switch.Set", {id: 0, on: powerStatus});
            let response = Shelly.call("HTTP", {url: buildPlugURL(this.plugName, "relay/0?turn="+desiredStatus), timeout: 2});
            // TODO: Check response and retry if error, see https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/#http-endpoint-relayid
        },
        updatePriority (newPriority) {
            // Does not update timeLastCrossedThreshold because watts are used for that, and validation/sanity check will catch issues
            if (newPriority == this.powerPriority){
                return;
            }
            let oldPriority = this.powerPriority;
            this.powerPriority = newPriority;
            plugDevicesByPriority[newPriority].push(this);
            let targetIndex = plugDevicesByPriority[this.oldPriority].findIndex((testPlug) => testPlug.plugName == this.plugName)
            plugDevicesByPriority[oldPriority].splice(targetIndex);
            // Assumes sort will be called right after this
        },
        /*  Averages power consumption, weighted with exponential decay by minutes, perhaps 1/(2^(x+1)).  
            Total with a Riemann sum (rectangles to the right of the decreasing weight curve).
            Weights will not exactly add to 1.0 , so divide by sum of weights to compensate.  
        */
        averageRecentConsumption () {
            let lastTime = null;
            let runningTotal = 0;
            let weightTotal = 0;
            for (const [time, consumption] of this.powerConsumption){
                if(lastTime != null){
                    let minutesAgo = (new Date() - time)/1000;
                    let minutesPeriod = (time - lastTime)/1000;
                    let weight = Math.pow(2, minutesAgo + 1);
                    weightTotal += weight;
                    runningTotal += consumption * weight * minutesPeriod;
                }
                lastTime = time;
            }
            this.averageRecentConsumption = runningTotal / weightTotal;
            return this.averageRecentConsumption;
        },
        getRecentConsumption () {
            return this.powerConsumption[this.lastUpdated];
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
function plugComparator(name1, name2){
    let plug1 = plugDevicesByName[name1];
    let plug2 = plugDevicesByName[name2];

    function determinePlugConsumptionTier(plug){
        // Significant load > insignificant load > no load
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
        // On long time > on short time > off long time > off short time
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
        let plugList = plugDevicesByName[priorityLevel];
        if (plugList === undefined){
            // No plugs at this priority level
            continue;
        }
        for(const currentPlugName of plugList){
            let currentPlug = plugDevicesByName[currentPlugName];
            if (!desiredPlugStatus){ // Shedding plugs, so look at present current consumption
                if (currentPlug.isCircuitClosed) {
                    remainingWatts -= currentPlug.powerConsumption;
                    plugNamesToToggle.unshift(currentPlugName);
                }
                if (remainingWatts <= 0) {
                    break;
                }
            } else { // Reenabling plugs, so try to power everything in this priority tier first before continuing down.  Use maximum current consumption to avoid overloading circuit in a few seconds.
                if(currentPlug.isCircuitClosed && currentPlug.highestConsumption <= remainingWatts){
                    remainingWatts -= currentPlug.highestConsumption;
                    plugNamesToToggle.push(currentPlugName);
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
    if(desiredPlugStatus){
        for (const currentPlugName of plugNamesToToggle) {
            let currentPlug = plugDevicesByName[currentPlugName];
            if (currentPlug.highestConsumption < -remainingWatts) {
                plugNamesToToggle.splice(plugIndex, 1);
                remainingWatts += currentPlug.highestConsumption;
            }
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

function decodeParam(params, paramName, type){
    // TODO: what if indexf fails?
    let startIndex = params.indexOf(paramName + "=") + paramName.length + 1;
    if(startIndex == -1){
        return null;
    }
    let endIndex = params.indexOf("&", startIndex);
    if(endIndex >= 0){
        var textValue = params.substring(startIndex, endIndex);
    }else{
        var textValue = params.substring(startIndex);
    }
    
    if (type == "number") {
        return Number(textValue);
    } else if (type == "string") {
        return textValue;
    } else if (type == "boolean") {
        if(length(textValue) == 0){
            return null;
        }
        if(!(textValue === "true" || textValue === "false")){
            throw new Error("Could not parse boolean");
        }
        return textValue === "true";
    } else {
        throw new Error("Invalid type to parse");
    }
}

export function updatePlug(request, response, userdata) {
    // Decode request parameters
    let params = request.query;
    let receivedTime = Date(); // Use internal clock for everything to avoid syncing clocks between devices
    console.log("DEBUG: Processing plug update request", params, "at time", receivedTime);
    // TODO: Gracefully handle errors thrown by parser
    let senderName = decodeParam(params, "sender", "string");
    let newPowerValue = decodeParam(params, "value", "number");
    let newCircuitStatus = decodeParam(params, "circuitclosed", "boolean");
    let senderPriority = decodeParam(params, "priority", "number");
    console.log("DEBUG: Params are", senderName, newPowerValue, newCircuitStatus. senderPriority);

    // Process parameters, responding with "bad request" if params are not as expected
    response.code = 200;
    if (senderName == null) {
        response.code = 400;
    }

    if (!plugDevicesByName.has(senderName)){
        createPlug(senderName, receivedTime, newPowerValue, senderPriority, newCircuitValue, false);
    } else {
        let senderObj = plugDevicesByName.get(senderName);
    
        if(newPowerValue !== null && !isNaN(newPowerValue)){
            if(!(0<newPowerValue)){
                response.code = 400;
            }else{
                senderObj.updatePower(receivedTime, newPowerValue);
            }
        }
        if(newCircuitStatus !== null){
            senderObj.isCircuitClosed = newCircuitStatus;
        }
        if(senderPriority !== null && !isNaN(senderPriority)){
            if(!(0<senderPriority<minPriority)){
                response.code = 400;
            }else{
                senderObj.updatePriority(senderPriority);
            }
        }
    }

    if (!response.send()){
        console.log("Failed to send response for request", params, "with status", response.code);
    }else{
        console.log("DEBUG: Sent response for request", params, "with status", response.code);
    }

    if(isLeader){
        verifyCircuitLoad();
    }
}

// Called by host OS when there is a status update
function statusUpdateHandler(status){
    if(status.component !== "switch:0"){ // TODO: Verify this is the correct status format
        return;
    }
    selfPlug.isCircuitClosed = status.output;
    selfPlug.updatePower(Date(), status.apower);
    needToUpdateOtherPlugs = true;
}
var statusListener = Shelly.addStatusHandler(statusUpdateHandler);
console.log("DEBUG: Registered internal status listener");

var updateHandlerURL = HTTPServer.registerEndpoint("updatePlug", updatePlug);
console.log("Registered plug update handler at", updateHandlerURL);
// Full URL will look like: http://Shelly-Plug.local/script/1/updatePlug?sender=OtherPlug&value=100&&circuitclosed=true&priority=1
// Each plug should update all plugs including itself, and this script should be the first so that script ID is consistent
// TODO: All updates should wait 1 second for inrush current to stabilize, especially for large transformers (like in cheap microwaves)
// TODO: Sending updates every 10 seconds as a heartbeat, so that offline plugs can be pruned from list
// TODO: Send updates to other plugs from this script, instead of via Shelly webhooks
// TODO: Send "hello" to other plugs upon startup, so they can reset their statistics, and add self to plug list.
// TODO: Periodically check needToUpdateOtherPlugs


/*  TODO: Make a system where plugs will decide which becomes the leader by longest time online.
    A leader plug that has been offline for 25 seconds (two check-in periods) is "voted out".
    Any plug can send a "voting motion" with a uniqute voting UID to the other plugs, 
    which triggers all to evalute the voting scenario. Each plug sends its vote to all the others, 
    then all plugs tally the votes and send their tally to the others.  If any plug detects a tally mismatch, 
    it sends a mismatch signal to the others, which rebroadcast it.  Then the vote is redone, 
    with a decreasing retry count until a fallback scenario is reached.  o0p

*/
export function processVoteRequest(request, response, userdata) {
    let params = request.query;
    let receivedTime = Date();
    console.log("DEBUG: Processing vote request", params, "at time", receivedTime);
    // TODO
}
var voteHandlerURL = HTTPServer.registerEndpoint("voteRequest", processVoteRequest);
console.log("Registered vote request handler at", voteHandlerURL);
