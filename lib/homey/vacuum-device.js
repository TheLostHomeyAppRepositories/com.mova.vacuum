'use strict';

const Homey = require('homey');
const { MovaCloudClient } = require('../mova/client');
const { mapDeviceStatusToHomey } = require('../mova/mapping');
const { serializeMapView, formatRoomList, parseRoomTagText } = require('../mova/map');
const { CONSUMABLES, SUCTION_LEVEL, WATER_LEVEL, normalizeRegion } = require('../mova/constants');

const MANAGED_CAPABILITIES = [
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
  'mova_last_start',
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
  mova_last_start: {
    title: { en: 'Last start', nl: 'Laatste start' },
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
    this._roomTokens = new Map();

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
    await this.syncRoomTokens();
  }

  _declaredCapabilities() {
    const fromManifest = this.driver && this.driver.manifest && this.driver.manifest.capabilities;
    if (Array.isArray(fromManifest) && fromManifest.length > 0) {
      return new Set(fromManifest);
    }
    return new Set(MANAGED_CAPABILITIES);
  }

  async _syncCapabilities() {
    const declared = this._declaredCapabilities();
    for (const id of declared) {
      if (!this.hasCapability(id)) {
        await this.addCapability(id);
      }
    }
    for (const id of MANAGED_CAPABILITIES) {
      if (!declared.has(id) && this.hasCapability(id)) {
        await this.removeCapability(id);
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

  _onCapability(id, listener) {
    if (!this.hasCapability(id)) {
      return;
    }
    this.registerCapabilityListener(id, listener);
  }

  _registerListeners() {
    this._onCapability('onoff', async (value) => {
      if (value) {
        this._onoffDockLatch = false;
        await this.startMop('vac_mop', 'onoff');
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

    this._onCapability('vacuumcleaner_state', async (value) => {
      if (value === 'cleaning' || value === 'spot_cleaning') {
        await this.startMop('vac_mop', 'vacuumcleaner_state');
        return;
      }
      if (value === 'docked' || value === 'charging') {
        await this.dock();
        return;
      }
      await this.stopCleaning();
    });

    this._onCapability('mova_start_vacuum', async () => {
      await this.startVacuum('mova_start_vacuum');
    });
    this._onCapability('mova_start_mop', async () => {
      await this.startMop('mop', 'mova_start_mop');
    });
    this._onCapability('mova_start_vac_mop', async () => {
      await this.startMop('vac_mop', 'mova_start_vac_mop');
    });
    this._onCapability('mova_pause', async () => {
      await this.pauseCleaning();
    });
    this._onCapability('mova_stop', async () => {
      await this.stopCleaning();
    });
    this._onCapability('mova_dock', async () => {
      await this.dock();
    });
    this._onCapability('mova_locate', async () => {
      await this.locate();
    });
    this._onCapability('mova_auto_empty', async () => {
      await this.startAutoEmpty();
    });
    this._onCapability('mova_wash_mop', async () => {
      await this.startWashing();
    });
    this._onCapability('mova_suction_level', async (value) => {
      await this.setSuctionLevel(value);
    });
    this._onCapability('mova_water_flow', async (value) => {
      await this.setWaterLevel(value);
    });
    this._onCapability('mova_cleangenius', async (value) => {
      await this.setCleanGenius(value);
    });

    for (const [capabilityId, consumableId] of Object.entries(CONSUMABLE_RESETS)) {
      this._onCapability(capabilityId, async () => {
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

  async startVacuum(source = 'startVacuum') {
    let snap;
    await this._runCommand('Start vacuuming', async () => {
      snap = await this._client.startVacuum(this._did());
    });
    await this._recordStart(source, snap);
  }

  async startMop(mode = 'mop', source = 'startMop') {
    let snap;
    await this._runCommand(`Start mopping (${mode})`, async () => {
      snap = await this._client.startMop(this._did(), mode);
    });
    await this._recordStart(source, snap);
  }

  async _recordStart(source, snap) {
    if (!snap) {
      return;
    }
    const after = snap.afterSet || {};
    const line = [
      `src=${source}`,
      `kind=${snap.kind}`,
      `wire=${snap.wire}`,
      `model=${snap.model || '-'}`,
      `style=${snap.style}`,
      `raw=${after.rawCleaningMode}`,
      `mode=${after.cleaningMode}`,
      `mop=${after.mopPadInstalled}`,
      `tank=${after.waterTank}`,
      `mopSt=${after.mopInStation}`,
      `mount=${after.autoMountMop}`,
      `st=${after.state}`,
      `stat=${after.status}`,
      `homey=${this.getCapabilityValue('mova_operational_status')}`,
    ].join(' ');
    this.log(`START ${line}`);
    if (this.hasCapability('mova_last_start')) {
      await this.setCapabilityValue('mova_last_start', line.slice(0, 250));
    }
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

  getCachedRooms() {
    const store = this.getStore() || {};
    return Array.isArray(store.rooms) ? store.rooms : [];
  }

  roomTypeName(typeKey) {
    const key = `settings.room_type.${typeKey}`;
    const translated = this.homey.__ && this.homey.__(key);
    if (!translated || translated === key) {
      return typeKey;
    }
    return translated;
  }

  getRoomSummary() {
    const store = this.getStore() || {};
    return {
      ok: true,
      id: this.getId(),
      name: this.getName(),
      fetchedAt: store.roomsFetchedAt || null,
      rooms: formatRoomList(this.getCachedRooms(), (typeKey) => this.roomTypeName(typeKey)),
    };
  }

  async _saveRooms(rooms, { stamp = false } = {}) {
    const compact = (Array.isArray(rooms) ? rooms : []).map((room) => ({
      id: Number(room.id),
      type: Number(room.type) || 0,
      customName: room.customName || '',
      hidden: Boolean(room.hidden),
    })).filter((room) => Number.isInteger(room.id) && room.id > 0 && room.id < 64);
    const prev = JSON.stringify(this.getCachedRooms());
    const same = prev === JSON.stringify(compact);
    if (!same) {
      await this.setStoreValue('rooms', compact);
    }
    if (!same || stamp) {
      await this.setStoreValue('roomsFetchedAt', Date.now());
    }
  }

  async refreshRooms() {
    if (this._mapViewPromise) {
      try {
        await this._mapViewPromise;
      } catch (_err) {
        // the refresh below reads the map again
      }
    }
    this._mapViewAt = 0;
    this._mapView = null;
    const payload = await this._fetchMapView({ wantRooms: true });
    if (!this.getCachedRooms().length) {
      const detail = payload && payload.error && payload.error !== 'No map data'
        ? payload.error
        : this.homey.__('settings.rooms_empty');
      throw new Error(detail);
    }
    await this.syncRoomTokens();
    return this.getRoomSummary();
  }

  _roomTokenId(roomId) {
    const deviceKey = String(this.getId()).replace(/[^a-zA-Z0-9]/g, '');
    return `room_${deviceKey}_${roomId}`;
  }

  _storedTokenTitles() {
    const stored = this.getStoreValue('roomTokenTitles');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return {};
    }
    return { ...stored };
  }

  _lookupRoomToken(id) {
    const cached = this._roomTokens && this._roomTokens.get(id);
    if (cached && cached.token) {
      return cached.token;
    }
    const flow = this.homey && this.homey.flow;
    if (!flow || typeof flow.getToken !== 'function') {
      return null;
    }
    try {
      return flow.getToken(id);
    } catch (_error) {
      return null;
    }
  }

  async _installRoomToken(id, title, value, previousTitle) {
    let token = this._lookupRoomToken(id);
    if (token && previousTitle === title) {
      await token.setValue(value);
      return token;
    }
    if (token) {
      this._roomTokens.delete(id);
      try {
        await token.unregister();
        token = null;
      } catch (error) {
        this.error('Room tag replace failed:', error.message);
        await token.setValue(value);
        return token;
      }
    }
    try {
      return await this.homey.flow.createToken(id, {
        type: 'string',
        title,
        value,
      });
    } catch (error) {
      const existing = this._lookupRoomToken(id);
      if (!existing) {
        throw error;
      }
      await existing.setValue(value);
      this.error(`Room tag ${title} already exists:`, error.message);
      return existing;
    }
  }

  async _clearRoomTokens() {
    if (!this._roomTokens) {
      this._roomTokens = new Map();
    }
    const titles = this._storedTokenTitles();
    const ids = new Set([...this._roomTokens.keys(), ...Object.keys(titles)]);
    for (const id of ids) {
      const token = this._lookupRoomToken(id);
      if (!token) {
        continue;
      }
      try {
        await token.unregister();
      } catch (error) {
        this.error('Room tag remove failed:', error.message);
      }
    }
    this._roomTokens = new Map();
    if (Object.keys(titles).length > 0) {
      try {
        await this.setStoreValue('roomTokenTitles', {});
      } catch (error) {
        this.error('Room tag store clear failed:', error.message);
      }
    }
  }

  async syncRoomTokens() {
    if (!this._roomTokens) {
      this._roomTokens = new Map();
    }
    const rooms = this.getRoomSummary().rooms.filter((room) => !room.hidden);
    const wanted = new Set(rooms.map((room) => this._roomTokenId(room.id)));
    const titles = this._storedTokenTitles();
    const knownIds = new Set([...this._roomTokens.keys(), ...Object.keys(titles)]);
    for (const id of knownIds) {
      if (wanted.has(id)) {
        continue;
      }
      const token = this._lookupRoomToken(id);
      this._roomTokens.delete(id);
      delete titles[id];
      if (!token) {
        continue;
      }
      try {
        await token.unregister();
      } catch (error) {
        this.error('Room tag remove failed:', error.message);
      }
    }
    for (const room of rooms) {
      const id = this._roomTokenId(room.id);
      const value = `mova-room:${room.id}`;
      const cached = this._roomTokens.get(id);
      const previousTitle = (cached && cached.title) || titles[id];
      try {
        const token = await this._installRoomToken(id, room.name, value, previousTitle);
        this._roomTokens.set(id, { token, title: room.name });
        titles[id] = room.name;
      } catch (error) {
        this.error(`Room tag ${room.name} failed:`, error.message);
      }
    }
    if (JSON.stringify(this.getStoreValue('roomTokenTitles') || {}) !== JSON.stringify(titles)) {
      await this.setStoreValue('roomTokenTitles', titles);
    }
  }

  async startRooms(kind, roomsText) {
    const mode = kind === 'mop' || kind === 'vac_mop' ? kind : 'vacuum';
    const parsed = parseRoomTagText(roomsText);
    const rooms = this.getRoomSummary().rooms.filter((room) => !room.hidden);
    const known = new Map(rooms.map((room) => [room.id, room]));
    if (parsed.empty) {
      throw new Error(this.homey.__('settings.room_tags_empty'));
    }
    if (parsed.invalid.length || parsed.ids.some((id) => !known.has(id))) {
      throw new Error(this.homey.__('settings.room_tags_only'));
    }
    const roomIds = [...new Set(parsed.ids)];
    const suctionName = this.getCapabilityValue('mova_suction_level') || 'standard';
    const waterName = this.getCapabilityValue('mova_water_flow') || 'medium';
    const suction = Object.prototype.hasOwnProperty.call(SUCTION_LEVEL, suctionName)
      ? SUCTION_LEVEL[suctionName]
      : SUCTION_LEVEL.standard;
    const water = Object.prototype.hasOwnProperty.call(WATER_LEVEL, waterName)
      ? WATER_LEVEL[waterName]
      : WATER_LEVEL.medium;
    let snap;
    await this._runCommand(`${mode} rooms ${roomIds.join(',')}`, async () => {
      snap = await this._client.startRoomClean(this._did(), roomIds, { suction, water, kind: mode });
    });
    await this._recordStart(mode === 'vacuum' ? 'room' : `room_${mode}`, snap);
  }

  async resetConsumable(consumableId) {
    const spec = CONSUMABLES[consumableId];
    const label = spec ? spec.capability : consumableId;
    await this._runCommand(`Reset ${label}`, () => this._client.resetConsumable(this._did(), consumableId));
  }

  async getMapView({ debug, wantRooms } = {}) {
    if (this._mapViewPromise) {
      const view = await this._mapViewPromise;
      return debug ? view : this._publicMapView(view);
    }
    const now = Date.now();
    if (!wantRooms && this._mapView && now - this._mapViewAt < 3000) {
      return debug ? this._mapView : this._publicMapView(this._mapView);
    }
    const fetchRooms = Boolean(wantRooms) || this.getCachedRooms().length === 0;
    this._mapViewPromise = this._fetchMapView({ wantRooms: fetchRooms }).finally(() => {
      this._mapViewPromise = null;
    });
    const view = await this._mapViewPromise;
    return debug ? view : this._publicMapView(view);
  }

  _publicMapView(view) {
    if (!view) {
      return view;
    }
    const { debug, objectName, rooms, ...rest } = view;
    return rest;
  }

  async _fetchMapView({ wantRooms = false } = {}) {
    const extra = {
      name: this.getName(),
      status: this.getCapabilityValue('mova_operational_status'),
      battery: this.getCapabilityValue('measure_battery'),
      deviceId: this.getId(),
    };
    try {
      await this._ensureSession();
      const store = this.getStore();
      const view = await this._client.getMapView(this._did(), {
        model: store.model,
        wantRooms,
      });
      if (view && Array.isArray(view.roomSources)) {
        this._roomSources = view.roomSources;
      }
      this._mapError = (view && (view.mapError || view.error)) || '';
      if (view && Array.isArray(view.rooms) && view.rooms.length) {
        await this._saveRooms(view.rooms, { stamp: wantRooms });
      }
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
      `MIOT state=${status.state} status=${status.status} charge=${status.chargingState} task=${status.taskStatus} error=${status.errorCode} rawMode=${status.rawCleaningMode} mode=${status.cleaningMode} water=${status.waterFlow} tank=${status.waterTank} mopInstalled=${status.mopPadInstalled} mopInStation=${status.mopInStation} autoMount=${status.autoMountMop} wash=${status.selfWashBaseStatus} → ${mapped.operationalStatus} onoff=${mapped.onoff} vac=${mapped.vacuumcleanerState} alarm=${mapped.error}`,
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
      await this.homey.flow.getDeviceTriggerCard('operational_status_changed').trigger(this, {
        status: mapped.operationalStatus,
      }, { status: mapped.operationalStatus }).catch(this.error);
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
    await this._clearRoomTokens();
  }

  async onUninit() {
    this._stopPolling();
  }
}

module.exports = MovaVacuumDevice;
