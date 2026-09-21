'use strict';

const Homey = require('homey');

const VACUUM_DRIVER_IDS = ['vacuum', 'dreame-vacuum'];

class MovaVacuumApp extends Homey.App {
  async onInit() {
    this.log('MOVA Vacuum app is running');
    this._registerSharedFlowCards();
  }

  _registerSharedFlowCards() {
    this.homey.flow.getActionCard('start_vacuum').registerRunListener(async (args) => {
      await args.device.startVacuum();
    });
    this._registerRoomFlowCard('vacuum_room', 'vacuum');
    this._registerRoomFlowCard('mop_room', 'mop');
    this._registerRoomFlowCard('vacmop_room', 'vac_mop');
    this.homey.flow.getActionCard('start_mop').registerRunListener(async (args) => {
      await args.device.startMop(args.mode || 'mop');
    });
    this.homey.flow.getActionCard('pause_vacuum').registerRunListener(async (args) => {
      await args.device.pauseCleaning();
    });
    this.homey.flow.getActionCard('stop_vacuum').registerRunListener(async (args) => {
      await args.device.stopCleaning();
    });
    this.homey.flow.getActionCard('clean').registerRunListener(async (args) => {
      await args.device.startMop('vac_mop', 'vacuumcleaner_state');
    });
    this.homey.flow.getActionCard('spot_clean').registerRunListener(async (args) => {
      await args.device.startMop('vac_mop', 'vacuumcleaner_state');
    });
    this.homey.flow.getActionCard('dock').registerRunListener(async (args) => {
      await args.device.dock();
    });
    this.homey.flow.getActionCard('stop').registerRunListener(async (args) => {
      await args.device.stopCleaning();
    });
    this.homey.flow.getActionCard('dock_vacuum').registerRunListener(async (args) => {
      await args.device.dock();
    });
    this.homey.flow.getActionCard('locate_vacuum').registerRunListener(async (args) => {
      await args.device.locate();
    });
    this.homey.flow.getActionCard('set_suction_level').registerRunListener(async (args) => {
      await args.device.setSuctionLevel(args.level);
    });
    this.homey.flow.getActionCard('set_water_flow').registerRunListener(async (args) => {
      await args.device.setWaterLevel(args.level);
    });
    this.homey.flow.getConditionCard('operational_status_is').registerRunListener(async (args) => {
      return args.device.getCapabilityValue('mova_operational_status') === args.status;
    });
    this.homey.flow.getDeviceTriggerCard('operational_status_changed').registerRunListener(async (args, state) => {
      if (!args.status || args.status === 'any') {
        return true;
      }
      return state.status === args.status;
    });
  }

  _registerRoomFlowCard(cardId, kind) {
    const card = this.homey.flow.getActionCard(cardId);
    card.registerRunListener(async (args) => {
      await args.device.startRooms(kind, args.rooms);
    });
  }

  _driverDevices(driverId) {
    try {
      return this.homey.drivers.getDriver(driverId).getDevices();
    } catch (_err) {
      return [];
    }
  }

  _vacuumDevices() {
    return VACUUM_DRIVER_IDS.flatMap((driverId) => this._driverDevices(driverId));
  }

  findVacuumDevice(deviceId) {
    const devices = this._vacuumDevices();
    if (deviceId) {
      const wanted = String(deviceId);
      const match = devices.find((device) => device.getId() === wanted)
        || devices.find((device) => String(device.getData().id) === wanted);
      if (match) {
        return match;
      }
    }
    if (devices.length === 1) {
      return devices[0];
    }
    return null;
  }

  listRooms() {
    const devices = this._vacuumDevices();
    if (!devices.length) {
      return { ok: false, error: 'no_device', devices: [] };
    }
    return {
      ok: true,
      devices: devices.map((device) => device.getRoomSummary()),
    };
  }

  async refreshRooms(deviceId) {
    const all = this._vacuumDevices();
    const wanted = deviceId ? String(deviceId) : '';
    const targets = wanted
      ? all.filter((device) => device.getId() === wanted || String(device.getData().id) === wanted)
      : all;
    if (!all.length || (wanted && !targets.length)) {
      return { ok: false, error: 'no_device', devices: [] };
    }
    const errors = new Map();
    const refreshed = new Map();
    for (const device of targets) {
      try {
        refreshed.set(device.getId(), await device.refreshRooms());
      } catch (error) {
        errors.set(device.getId(), error.message);
      }
    }
    return {
      ok: errors.size === 0,
      devices: all.map((device) => {
        const fresh = refreshed.get(device.getId());
        if (fresh && !errors.has(device.getId())) {
          return fresh;
        }
        const summary = device.getRoomSummary();
        const error = errors.get(device.getId());
        return error ? { ...summary, ok: false, error } : summary;
      }),
    };
  }

  async getMapView(deviceId, options = {}) {
    const devices = this._vacuumDevices();
    const device = this.findVacuumDevice(deviceId);
    if (!device) {
      return {
        ok: false,
        error: devices.length === 0 ? 'no_device' : 'select_device',
        devices: devices.map((item) => ({
          id: item.getId(),
          name: item.getName(),
        })),
      };
    }
    return device.getMapView(options);
  }
}

module.exports = MovaVacuumApp;
