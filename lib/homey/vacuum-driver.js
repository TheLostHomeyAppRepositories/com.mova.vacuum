'use strict';

const Homey = require('homey');
const { attachPairSession, attachRepairSession } = require('./pair');

function createCloudVacuumDriver({ family = 'mova', label = 'MOVA Vacuum' } = {}) {
  return class MovaCloudVacuumDriver extends Homey.Driver {
    async onInit() {
      this.log(`${label} driver initialized`);
      if (family === 'mova') {
        this._registerDockFlowCards();
      }
    }

    _registerDockFlowCards() {
      this.homey.flow.getActionCard('empty_dustbin').registerRunListener(async (args) => {
        await args.device.startAutoEmpty();
      });
      this.homey.flow.getActionCard('wash_mop').registerRunListener(async (args) => {
        await args.device.startWashing();
      });
      this.homey.flow.getActionCard('set_cleangenius').registerRunListener(async (args) => {
        await args.device.setCleanGenius(args.level);
      });
      this.homey.flow.getConditionCard('cleangenius_is').registerRunListener(async (args) => {
        return args.device.getCapabilityValue('mova_cleangenius') === args.level;
      });
    }

    async onPair(session) {
      attachPairSession(this, session, family);
    }

    async onRepair(session, device) {
      attachRepairSession(this, session, device);
    }
  };
}

module.exports = {
  createCloudVacuumDriver,
};
