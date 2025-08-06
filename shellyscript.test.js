//const balancescript = require('./shellyscript');
import {shellyloadbalancer} from './shellyscript.js';

/*
jest.mock('HTTPServer')
HTTPServer.registerEndpoint.mockResolvedValue("localhost/updatePlugPower")
*/

test('Create, update, and sort plugs', function() {

    let currentTime = new Date();
    let fiveSecondsAgo = new Date(currentTime.getTime() - 5*1000);
    shellyloadbalancer.createPlug("plug1", currentTime, 1000, 1);
    shellyloadbalancer.createPlug("plug2", fiveSecondsAgo, 1000, 1);
    shellyloadbalancer.plugDevicesByName['plug2'].updatePower(currentTime, 40);
    // plug1 should now be ahead of plug2, since plug2 is no longer consuming a significant amount of power

    expect(shellyloadbalancer.plugDevicesByPriority[1].length).toBe(2);
    expect(shellyloadbalancer.plugDevicesByPriority[1][0].plugName).toBe('plug1');
    expect(shellyloadbalancer.plugDevicesByPriority[1][1].plugName).toBe('plug2');
});