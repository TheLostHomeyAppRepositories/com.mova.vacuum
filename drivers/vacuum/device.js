'use strict';

const Homey = require('homey');
const { MovaCloudClient } = require('../../lib/mova/client');
const { mapDeviceStatusToHomey } = require('../../lib/mova/mapping');
const { serializeMapView } = require('../../lib/mova/map');
const { CONSUMABLES, normalizeRegion } = require('../../lib/mova/constants');

const ACTION_CAPABILITIES = [
  'mova_start_vac_mop',
  'mova_start_vacuum',
  'mova_start_mop',
  'mova_pause',
  'mova_stop',
  'mova_dock',
  'mova_locate',
  'mova_auto_empty',
  'mova_wash_mop',
  'mova_suction_level',
  'mova_water_flow',
  'mova_cleangenius',
  'mova_cleaning_time',
  'mova_cleaned_area',
  'measure_main_brush',
  'measure_side_brush',
  'measure_filter',
  'measure_mop',
  'measure_sensor',
  'alarm_consumable',
  'alarm_generic',
  'button.reset_main_brush',
  'button.reset_side_brush',
  'button.reset_filter',
  'button.reset_mop',
  'button.reset_sensor',
];

const CONSUMABLE_RESETS = {
  'button.reset_main_brush': 'mainBrush',
  'button.reset_side_brush': 'sideBrush',
  'button.reset_filter': 'filter',
  'button.reset_mop': 'mopPad',
  'button.reset_sensor': 'sensor',
};

const LEGACY_BUTTONS = [
  'button.start_vac_mop',
  'button.start_vacuum',
  'button.start_mop',
  'button.pause',
  'button.stop',
  'button.dock',
];

const CAPABILITY_ICONS = {
  onoff: {
    title: { en: 'Clean', nl: 'Reinigen' },
    icon: '/assets/icons/sparkles.svg',
    uiQuickAction: true,
  },
  mova_start_vac_mop: {
    title: { en: 'Start vacuum & mop', nl: 'Stofzuigen en dweilen' },
    icon: '/assets/icons/sparkles.svg',
  },
  mova_start_vacuum: {
    title: { en: 'Start vacuuming', nl: 'Stofzuigen starten' },
    icon: '/assets/icons/start_vacuum.svg',
  },
  mova_start_mop: {
    title: { en: 'Start mopping', nl: 'Dweilen starten' },
    icon: '/assets/icons/start_mop.svg',
  },
  mova_pause: {
    title: { en: 'Pause', nl: 'Pauzeren' },
    icon: '/assets/icons/pause.svg',
  },
  mova_stop: {
    title: { en: 'Stop', nl: 'Stoppen' },
    icon: '/assets/icons/stop.svg',
  },
  mova_dock: {
    title: { en: 'Return to dock', nl: 'Naar het station' },
    icon: '/assets/icons/dock.svg',
  },
  mova_locate: {
    title: { en: 'Locate', nl: 'Lokaliseren' },
    icon: '/assets/icons/locate.svg',
  },
  mova_auto_empty: {
    title: { en: 'Empty dustbin', nl: 'Stofbak legen' },
    icon: '/assets/icons/empty.svg',
  },
  mova_wash_mop: {
    title: { en: 'Wash mop', nl: 'Dweil wassen' },
    icon: '/assets/icons/wash.svg',
  },
  mova_suction_level: {
    title: { en: 'Suction', nl: 'Zuigkracht' },
    icon: '/assets/icons/suction.svg',
  },
  mova_water_flow: {
    title: { en: 'Water level', nl: 'Waterstand' },
    icon: '/assets/icons/water.svg',
  },
  mova_cleangenius: {
    title: { en: 'CleanGenius', nl: 'CleanGenius' },
    icon: '/assets/icons/cleangenius.svg',
  },
  vacuumcleaner_state: {
    title: { en: 'Vacuum state', nl: 'Stofzuigerstatus' },
    uiComponent: null,
  },
};

class MovaVacuumDevice extends Homey.Device {
  async onInit() {
    this._pollTimer = null;
    this._busy = false;
    this._onoffDockLatch = false;
    this._client = this._createClient();
    this._mapView = null;
    this._mapViewAt = 0;
    this._mapViewPromise = null;

    await this._syncCapabilities();
    this._registerListeners();

    try {
      await this._ensureSession();
      await this.poll();
      await this.setAvailable();
    } catch (error) {
      this.error('Init failed:', error.message);
      await this.setUnavailable(error.message);
    }

    this._startPolling();
  }

  async _syncCapabilities() {
    for (const id of ACTION_CAPABILITIES) {
      if (!this.hasCapability(id)) {
        await this.addCapability(id);
      }
    }
    for (const id of LEGACY_BUTTONS) {
      if (this.hasCapability(id)) {
        await this.removeCapability(id);
      }
    }
    for (const [id, options] of Object.entries(CAPABILITY_ICONS)) {
      if (!this.hasCapability(id)) {
        continue;
      }
      try {
        await this.setCapabilityOptions(id, options);
      } catch (error) {
        this.error(`Icon options for ${id} failed:`, error.message);
      }
    }
  }

  _registerListeners() {
    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        this._onoffDockLatch = false;
        await this.startMop('vac_mop');
        return;
      }
      try {
        await this.dock();
        this._onoffDockLatch = true;
      } catch (error) {
        this._onoffDockLatch = false;
        throw error;
      }
    });

    this.registerCapabilityListener('vacuumcleaner_state', async (value) => {
      if (value === 'cleaning' || value === 'spot_cleaning') {
        await this.startMop('vac_mop');
        return;
      }
      if (value === 'docked' || value === 'charging') {
        await this.dock();
        return;
      }
      await this.stopCleaning();
    });

    this.registerCapabilityListener('mova_start_vacuum', async () => {
      await this.startVacuum();
    });
    this.registerCapabilityListener('mova_start_mop', async () => {
      await this.startMop('mop');
    });
    this.registerCapabilityListener('mova_start_vac_mop', async () => {
      await this.startMop('vac_mop');
    });
    this.registerCapabilityListener('mova_pause', async () => {
      await this.pauseCleaning();
    });
    this.registerCapabilityListener('mova_stop', async () => {
      await this.stopCleaning();
    });
    this.registerCapabilityListener('mova_dock', async () => {
      await this.dock();
    });
    this.registerCapabilityListener('mova_locate', async () => {
      await this.locate();
    });
    this.registerCapabilityListener('mova_auto_empty', async () => {
      await this.startAutoEmpty();
    });
    this.registerCapabilityListener('mova_wash_mop', async () => {
      await this.startWashing();
    });
    this.registerCapabilityListener('mova_suction_level', async (value) => {
      await this.setSuctionLevel(value);
    });
    this.registerCapabilityListener('mova_water_flow', async (value) => {
      await this.setWaterLevel(value);
    });
    this.registerCapabilityListener('mova_cleangenius', async (value) => {
      await this.setCleanGenius(value);
    });

    for (const [capabilityId, consumableId] of Object.entries(CONSUMABLE_RESETS)) {
      this.registerCapabilityListener(capabilityId, async () => {
        await this.resetConsumable(consumableId);
      });
    }
  }

  _createClient() {
    const store = this.getStore();
    const client = new MovaCloudClient({
      username: store.username,
      password: store.password,
      region: normalizeRegion(store.region),
      logger: this,
    });
    client.setDeviceContext(this.getData().id, {
      bindDomain: store.bindDomain,
      model: store.model,
    });
    if (store.accessToken) {
      client.setSession({
        accessToken: store.accessToken,
        refreshToken: store.refreshToken,
        expiresAt: store.expiresAt,
        uid: store.uid,
        region: store.region,
      });
    }
    return client;
  }

  async applyCredentials({ username, password, region, session }) {
    this._client = new MovaCloudClient({
      username,
      password,
      region: normalizeRegion(region),
      logger: this,
    });
    const store = this.getStore();
    this._client.setDeviceContext(this.getData().id, {
      bindDomain: store.bindDomain,
      model: store.model,
    });
    if (session) {
      this._client.setSession(session);
    }
    this._startPolling();
    await this.poll();
  }

  async _ensureSession() {
    await this._client.ensureSession();
    await this._persistSession();
  }

  async _persistSession() {
    const session = this._client.getSession();
    if (!session) {
      return;
    }
    await this.setStoreValue('accessToken', session.accessToken);
    await this.setStoreValue('refreshToken', session.refreshToken);
    await this.setStoreValue('expiresAt', session.expiresAt);
    await this.setStoreValue('uid', session.uid);
  }

  _did() {
    return this.getData().id;
  }

  async _runCommand(label, fn) {
    if (this._busy) {
      throw new Error('Another command is already running');
    }
    this._busy = true;
    try {
      this.log(label);
      await this._ensureSession();
      await fn();
      await this.poll();
    } catch (error) {
      this.error(`${label} failed:`, error.message);
      throw error;
    } finally {
      this._busy = false;
    }
  }

  async startVacuum() {
    await this._runCommand('Start vacuuming', () => this._client.startVacuum(this._did()));
  }

  async startMop(mode = 'mop') {
    await this._runCommand(`Start mopping (${mode})`, () => this._client.startMop(this._did(), mode));
  }

  async pauseCleaning() {
    await this._runCommand('Pause', () => this._client.pause(this._did()));
  }

  async stopCleaning() {
    await this._runCommand('Stop', () => this._client.stop(this._did()));
  }

  async dock() {
    await this._runCommand('Return to dock', () => this._client.dock(this._did()));
  }

  async locate() {
    await this._runCommand('Locate', () => this._client.locate(this._did()));
  }

  async startAutoEmpty() {
    await this._runCommand('Empty dustbin', () => this._client.startAutoEmpty(this._did()));
  }

  async startWashing() {
    await this._runCommand('Wash mop', () => this._client.startWashing(this._did()));
  }

  async setSuctionLevel(level) {
    await this._runCommand(`Set suction (${level})`, () => this._client.setSuctionLevel(this._did(), level));
  }

  async setWaterLevel(level) {
    await this._runCommand(`Set water (${level})`, () => this._client.setWaterLevel(this._did(), level));
  }

  async setCleanGenius(level) {
    await this._runCommand(`Set CleanGenius (${level})`, () => this._client.setCleanGenius(this._did(), level));
  }

  async resetConsumable(consumableId) {
    const spec = CONSUMABLES[consumableId];
    const label = spec ? spec.capability : consumableId;
    await this._runCommand(`Reset ${label}`, () => this._client.resetConsumable(this._did(), consumableId));
  }

  async getMapView({ debug } = {}) {
    if (this._mapViewPromise) {
      const view = await this._mapViewPromise;
      return debug ? view : this._publicMapView(view);
    }
    const now = Date.now();
    if (this._mapView && now - this._mapViewAt < 3000) {
      return debug ? this._mapView : this._publicMapView(this._mapView);
    }
    this._mapViewPromise = this._fetchMapView().finally(() => {
      this._mapViewPromise = null;
    });
    const view = await this._mapViewPromise;
    return debug ? view : this._publicMapView(view);
  }

  _publicMapView(view) {
    if (!view) {
      return view;
    }
    const { debug, objectName, ...rest } = view;
    return rest;
  }

  async _fetchMapView() {
    const extra = {
      name: this.getName(),
      status: this.getCapabilityValue('mova_operational_status'),
      battery: this.getCapabilityValue('measure_battery'),
      deviceId: this.getId(),
    };
    try {
      await this._ensureSession();
      const store = this.getStore();
      const view = await this._client.getMapView(this._did(), { model: store.model });
      const payload = serializeMapView(view, extra);
      if (payload.ok) {
        this._mapView = payload;
        this._mapViewAt = Date.now();
      } else if (this._mapView) {
        return { ...this._mapView, stale: true };
      }
      return payload;
    } catch (error) {
      this.error('Map fetch failed:', error.message);
      if (this._mapView) {
        return { ...this._mapView, stale: true, error: error.message };
      }
      return serializeMapView({ ok: false, error: error.message }, extra);
    }
  }

  async poll() {
    const did = this._did();
    const status = await this._client.getProperties(did);
    const mapped = mapDeviceStatusToHomey(status);
    this.log(
      `MIOT state=${status.state} status=${status.status} charge=${status.chargingState} task=${status.taskStatus} error=${status.errorCode} mode=${status.cleaningMode} water=${status.waterFlow} tank=${status.waterTank} mopInstalled=${status.mopPadInstalled} → ${mapped.operationalStatus} onoff=${mapped.onoff} vac=${mapped.vacuumcleanerState} alarm=${mapped.error}`,
    );
    const previous = this.getCapabilityValue('mova_operational_status');

    await this._setIfChanged('measure_battery', mapped.battery);
    await this._setIfChanged('mova_operational_status', mapped.operationalStatus);
    await this._setIfChanged('vacuumcleaner_state', mapped.vacuumcleanerState);
    await this._setIfChanged('onoff', this._onoffValue(mapped.onoff));
    await this._setIfChanged('mova_suction_level', mapped.suctionLevel);
    await this._setIfChanged('mova_water_flow', mapped.waterLevel);
    await this._setIfChanged('mova_cleangenius', mapped.cleanGenius);
    await this._setIfChanged('alarm_generic', mapped.error);
    await this._setIfChanged('mova_cleaning_time', mapped.cleaningTime);
    await this._setIfChanged('mova_cleaned_area', mapped.cleanedArea);
    await this._setIfChanged('measure_main_brush', mapped.mainBrush);
    await this._setIfChanged('measure_side_brush', mapped.sideBrush);
    await this._setIfChanged('measure_filter', mapped.filter);
    await this._setIfChanged('measure_mop', mapped.mopPad);
    await this._setIfChanged('measure_sensor', mapped.sensor);
    await this._setIfChanged('alarm_consumable', mapped.consumableLow);

    if (previous !== mapped.operationalStatus) {
      const driver = this.driver;
      if (driver && driver.operationalStatusTrigger) {
        await driver.operationalStatusTrigger.trigger(this, {
          status: mapped.operationalStatus,
        }, { status: mapped.operationalStatus }).catch(this.error);
      }
    }
  }

  _onoffValue(onoff) {
    if (!this._onoffDockLatch) {
      return onoff;
    }
    if (onoff) {
      return false;
    }
    this._onoffDockLatch = false;
    return false;
  }

  async _setIfChanged(capability, value) {
    if (!this.hasCapability(capability) || value === undefined || value === null) {
      return;
    }
    const current = this.getCapabilityValue(capability);
    if (current === value) {
      return;
    }
    await this.setCapabilityValue(capability, value);
  }

  _pollMs() {
    const settings = this.getSettings() || {};
    const seconds = Number(settings.poll_interval);
    const safe = Number.isFinite(seconds) ? Math.max(10, Math.min(300, seconds)) : 30;
    return safe * 1000;
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = this.homey.setInterval(() => {
      this.poll().catch((error) => {
        this.error('Poll failed:', error.message);
      });
    }, this._pollMs());
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._startPolling();
    }
    return newSettings;
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onUninit() {
    this._stopPolling();
  }
}

module.exports = MovaVacuumDevice;
