'use strict';

module.exports = {
  async getMap({ homey, query }) {
    return homey.app.getMapView(query.deviceId || query.id, {
      debug: query.debug === '1' || query.debug === 'true',
    });
  },

  async getRooms({ homey }) {
    return homey.app.listRooms();
  },

  async refreshRooms({ homey, body }) {
    const deviceId = body && (body.deviceId || body.id);
    return homey.app.refreshRooms(deviceId || null);
  },
};
