'use strict';

const crypto = require('crypto');
const {
  PASSWORD_SALT,
  AUTH_BASIC,
  CLIENT_ID,
  TENANT_ID,
  USER_AGENT,
  AUTH_ENDPOINT,
  DEVICE_LIST_ENDPOINT,
  MIOT_PROPERTIES,
  MIOT_ACTIONS,
  CONSUMABLES,
  usesSwappedCleaningMode,
  wireCleaningMode,
  logicalCleaningModeFromRaw,
  DreameState,
  MovaStatus,
  SUCTION_LEVEL,
  WATER_LEVEL,
  CLEAN_GENIUS,
  AUTO_SWITCH_CLEAN_GENIUS_KEY,
  GET_DEVICE_DATA_ENDPOINT,
  MAP_DOWNLOAD_ENDPOINT,
  MAP_DOWNLOAD_ENDPOINT_ALT,
  normalizeRegion,
  getApiBaseUrl,
  getSendCommandPath,
  statusPropertyKeysForModel,
} = require('./constants');
const { createTransport, parseJsonSafe } = require('./http');
const { extractDeviceRecords, filterPairableVacuums, listV2ModelSummary, vacuumsFromListV2 } = require('./devices');
const { miotPropertiesToStatus } = require('./mapping');
const {
  decodeMapPayload,
  toViewModel,
  extractMapProperty,
  objectNameFromValue,
  objectNameFromMapList,
  objectNamesFromMapFile,
  decodeSavedMapContainer,
  serializeMapView,
  mergeRooms,
  describeMapExtra,
} = require('./map');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashPassword(password) {
  return crypto.createHash('md5').update(String(password) + PASSWORD_SALT, 'utf8').digest('hex');
}

function tokenErrorMessage(error, fallback) {
  const body = error && error.body;
  let parsed = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch (_err) {
      parsed = null;
    }
  }
  const description = parsed && (parsed.error_description || parsed.error || parsed.msg || parsed.message);
  if (description) {
    return `MOVAhome login failed: ${description}`;
  }
  return fallback || (error && error.message) || 'MOVAhome login failed';
}

function noop() {}

function bindLog(logger, names) {
  if (!logger) {
    return noop;
  }
  for (const name of names) {
    if (typeof logger[name] === 'function') {
      return logger[name].bind(logger);
    }
  }
  return noop;
}

function makeLogger(logger) {
  return {
    info: bindLog(logger, ['info', 'log']),
    warn: bindLog(logger, ['warn', 'log']),
    error: bindLog(logger, ['error', 'log']),
    debug: bindLog(logger, ['debug', 'log']),
  };
}

function unwrapPropertyResults(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.result)) {
    return payload.result;
  }
  if (payload && payload.data) {
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    if (Array.isArray(payload.data.result)) {
      return payload.data.result;
    }
  }
  return [];
}

class MovaCloudClient {
  /**
   * Pure MOVAhome cloud client (login, listV2, get_properties, sendCommand).
   * Inject `http` or `fetch` to mock cloud HTTP in tests.
   */
  constructor(options = {}) {
    this.username = options.username || '';
    this.password = options.password || '';
    this.region = normalizeRegion(options.region);
    this._http = createTransport(options);
    this._log = makeLogger(options.logger);
    this._messageId = 0;
    this._session = null;
    this._bindDomains = new Map();
    this._models = new Map();
    this._liftingDids = new Set();
    this._modeStyle = 'dreame';
    this._mapFrames = new Map();
    this._download = typeof options.download === 'function' ? options.download : null;
    this._mapRequested = new Set();
  }

  getSession() {
    if (!this._session) {
      return null;
    }
    return { ...this._session };
  }

  setSession(session) {
    if (!session || !session.accessToken) {
      this._session = null;
      return;
    }
    this._session = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken || '',
      expiresAt: session.expiresAt || 0,
      uid: session.uid || '',
      region: session.region || this.region,
    };
    if (session.region) {
      this.region = normalizeRegion(session.region);
    }
  }

  setDeviceContext(did, context = {}) {
    const id = String(did);
    if (context.bindDomain) {
      this._bindDomains.set(id, context.bindDomain);
    }
    if (context.model) {
      this._models.set(id, context.model);
      this._modeStyle = usesSwappedCleaningMode(context.model) ? 's70' : 'dreame';
    }
  }

  _baseUrl() {
    return getApiBaseUrl(this.region);
  }

  _commonHeaders(extra = {}) {
    const headers = {
      Accept: '*/*',
      'Accept-Language': 'en-US;q=0.8',
      'User-Agent': USER_AGENT,
      Authorization: AUTH_BASIC,
      'Tenant-Id': TENANT_ID,
      ...extra,
    };
    if (this.region === 'cn') {
      headers['Dreame-Rlc'] = CLIENT_ID;
    }
    return headers;
  }

  _authHeaders(contentType) {
    if (!this._session || !this._session.accessToken) {
      throw new Error('Not logged in to MOVAhome');
    }
    return this._commonHeaders({
      'Content-Type': contentType,
      'Dreame-Auth': this._session.accessToken,
    });
  }

  async _request(url, { method = 'GET', headers = {}, body } = {}) {
    const response = await this._http({ url, method, headers, body });
    const status = response.status;
    const text = response.text === undefined || response.text === null ? '' : String(response.text);
    if (status < 200 || status >= 300) {
      const error = new Error(`MOVAhome HTTP ${status}: ${text.slice(0, 300)}`);
      error.status = status;
      error.body = text;
      throw error;
    }
    if (!text) {
      return null;
    }
    return parseJsonSafe(text);
  }

  _setSessionFromToken(json) {
    const payload = json && json.access_token ? json : (json && json.data) || json || {};
    if (!payload.access_token) {
      const message = (json && (json.msg || json.message || json.error_description || json.error)) || 'No access token received';
      throw new Error(`MOVAhome login failed: ${message}`);
    }
    this._session = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || '',
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      uid: payload.uid || payload.tenant_id || '',
      region: this.region,
    };
    return this.getSession();
  }

  async _postToken(body, extraHeaders = {}) {
    const url = `${this._baseUrl()}${AUTH_ENDPOINT}`;
    try {
      return await this._request(url, {
        method: 'POST',
        headers: this._commonHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          ...extraHeaders,
        }),
        body,
      });
    } catch (error) {
      throw new Error(tokenErrorMessage(error, error.message));
    }
  }

  /**
   * OAuth password grant to `{region}.iot.mova-tech.com:13267/dreame-auth/oauth/token`.
   * Password is MD5(password + salt `RAylYC%fmSKp7%Tq`).
   */
  async login(username, password, region) {
    if (username !== undefined) {
      this.username = username;
    }
    if (password !== undefined) {
      this.password = password;
    }
    if (region !== undefined) {
      this.region = normalizeRegion(region);
    }
    if (!this.username || !this.password) {
      throw new Error('MOVAhome username and password are required');
    }

    const passwordHash = hashPassword(this.password);
    const body = new URLSearchParams({
      platform: 'IOS',
      scope: 'all',
      grant_type: 'password',
      username: this.username,
      password: passwordHash,
      type: 'account',
    }).toString();

    this._log.info(`Logging in to MOVAhome (${this.region})`);
    const json = await this._postToken(body);
    return this._setSessionFromToken(json);
  }

  async refresh(refreshToken) {
    const token = refreshToken || (this._session && this._session.refreshToken) || '';
    if (!token) {
      throw new Error('No MOVAhome refresh token');
    }
    const body = new URLSearchParams({
      platform: 'IOS',
      scope: 'all',
      grant_type: 'refresh_token',
      refresh_token: token,
    }).toString();
    this._log.info(`Refreshing MOVAhome session (${this.region})`);
    const json = await this._postToken(body);
    return this._setSessionFromToken(json);
  }

  async _ensureSession() {
    if (this._session && this._session.accessToken && Date.now() < this._session.expiresAt - 60 * 1000) {
      return;
    }
    if (this._session && this._session.refreshToken) {
      try {
        await this.refresh();
        return;
      } catch (error) {
        this._log.warn(`Token refresh failed: ${error.message}`);
      }
    }
    if (this.username && this.password) {
      await this.login();
      return;
    }
    throw new Error('MOVAhome login expired. Repair this device with your MOVAhome email and password. Set a password in the official MOVAhome app first if you signed up with Apple ID.');
  }

  async ensureSession() {
    await this._ensureSession();
    return this.getSession();
  }

  async _api(endpoint, body) {
    await this._ensureSession();
    const url = `${this._baseUrl()}${endpoint}`;
    const json = await this._request(url, {
      method: 'POST',
      headers: this._authHeaders('application/json'),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return json;
  }

  _logListV2Summary(json) {
    const summary = listV2ModelSummary(json);
    this._log.info(`listV2 records=${summary.count} models=${summary.models.join(', ') || '(none)'}`);
    return summary;
  }

  /**
   * Discover bound devices via `device/listV2`.
   * `family: 'mova'` keeps `mova.vacuum.*`; `family: 'dreame'` keeps `dreame.vacuum.*`.
   */
  async listDevices(options = {}) {
    const family = options.family === 'dreame' ? 'dreame' : 'mova';
    await this._ensureSession();
    const bodies = [
      { page: 1, pageSize: 100 },
      { sharedStatus: 1, current: 1, size: 100, timestamp: Date.now() },
      undefined,
    ];

    let lastBody = null;
    for (const body of bodies) {
      const json = await this._api(DEVICE_LIST_ENDPOINT, body);
      lastBody = json;
      const records = extractDeviceRecords(json);
      if (records.length === 0) {
        continue;
      }
      this._logListV2Summary(json);
      const vacuums = filterPairableVacuums(records, family);
      for (const device of vacuums) {
        this.setDeviceContext(device.did, device);
      }
      return vacuums;
    }
    if (lastBody) {
      this._logListV2Summary(lastBody);
    }
    return vacuumsFromListV2(lastBody, family);
  }

  async sendCommand(did, method, params) {
    await this._ensureSession();
    const id = ++this._messageId;
    const deviceId = String(did);
    const bindDomain = this._bindDomains.get(deviceId);
    const endpoint = getSendCommandPath(bindDomain);

    let formattedParams = params;
    if (method === 'action' && Array.isArray(params) && params.length >= 2) {
      formattedParams = {
        did: deviceId,
        siid: params[0],
        aiid: params[1],
        in: params[2] || [],
      };
    } else if (method === 'set_properties' && Array.isArray(params)) {
      formattedParams = params.map((prop) => ({
        did: deviceId,
        siid: prop.siid,
        piid: prop.piid,
        value: prop.value,
      }));
    } else if (method === 'get_properties' && Array.isArray(params)) {
      formattedParams = params.map((prop) => ({
        did: deviceId,
        siid: prop.siid,
        piid: prop.piid,
      }));
    }

    const requestBody = {
      did: deviceId,
      id,
      data: {
        did: deviceId,
        id,
        method,
        params: formattedParams,
      },
    };

    this._log.debug(`sendCommand ${method} ${endpoint}`);
    const json = await this._api(endpoint, requestBody);
    if (json && json.code !== undefined && json.code !== 0) {
      throw new Error(`MOVAhome command ${method} failed: code=${json.code}, msg=${json.msg || 'unknown error'}`);
    }
    return json && json.data !== undefined ? json.data : json;
  }

  async setCleaningMode(did, cleaningMode) {
    return this.sendCommand(did, 'set_properties', [{
      siid: MIOT_PROPERTIES.cleaningMode.siid,
      piid: MIOT_PROPERTIES.cleaningMode.piid,
      value: cleaningMode,
    }]);
  }

  async sendAction(did, action, input = []) {
    return this.sendCommand(did, 'action', [action.siid, action.aiid, input]);
  }

  _modeStyleFor(did) {
    const id = String(did);
    if (this._liftingDids.has(id)) {
      return 's70';
    }
    const model = this._models.get(id);
    if (usesSwappedCleaningMode(model)) {
      return 's70';
    }
    return this._modeStyle;
  }

  _swapped(did) {
    return this._modeStyleFor(did) === 's70';
  }

  _logicalCleaningMode(did, raw) {
    return logicalCleaningModeFromRaw(raw, this._swapped(did));
  }

  _cleaningModeValue(kind, did, currentRaw) {
    return wireCleaningMode(kind, currentRaw, this._swapped(did));
  }

  _isDockMopCycle(status) {
    const state = Number(status && status.state);
    const st = Number(status && status.status);
    const wash = Number(status && status.selfWashBaseStatus);
    return state === DreameState.Drying
      || state === DreameState.Washing
      || st === MovaStatus.Drying
      || st === MovaStatus.Washing
      || wash === 1
      || wash === 2;
  }

  _startMeta(kind, did, wire) {
    return {
      kind,
      did: String(did),
      model: this._models.get(String(did)) || null,
      style: this._modeStyleFor(did),
      wire,
    };
  }

  async _startWithMode(did, kind) {
    const current = await this.getProperties(did);
    if (Number(current.autoMountMop) === 1) {
      this._liftingDids.add(String(did));
    }
    if (kind === 'vacuum' && this._isDockMopCycle(current)) {
      this._log.info('stop dock mop cycle before vacuum-only start');
      await this.stop(did);
      await sleep(800);
    }
    const wire = this._cleaningModeValue(kind, did, current.rawCleaningMode);
    const meta = this._startMeta(kind, did, wire);
    this._log.info(
      `start ${kind} did=${meta.did} model=${meta.model} style=${meta.style} wire=${wire} prevRaw=${current.rawCleaningMode}`,
    );
    await this.setCleaningMode(did, wire);
    const afterSet = await this.getProperties(did);
    this._log.info(
      `after set_mode raw=${afterSet.rawCleaningMode} logical=${afterSet.cleaningMode} mop=${afterSet.mopPadInstalled} tank=${afterSet.waterTank} mopInStation=${afterSet.mopInStation} autoMount=${afterSet.autoMountMop} wash=${afterSet.selfWashBaseStatus} state=${afterSet.state} status=${afterSet.status} charge=${afterSet.chargingState}`,
    );
    await this.sendAction(did, MIOT_ACTIONS.startClean);
    return { ...meta, afterSet, prevRaw: current.rawCleaningMode };
  }

  async startVacuum(did) {
    return this._startWithMode(did, 'vacuum');
  }

  /**
   * @param {string} did
   * @param {'mop'|'vac_mop'} [mode]
   */
  async startMop(did, mode = 'mop') {
    return this._startWithMode(did, mode === 'vac_mop' ? 'vac_mop' : 'mop');
  }

  /**
   * Vacuum one or more mapped rooms. Room ids come from the map's seg_inf.
   * @param {string} did
   * @param {number[]} roomIds
   * @param {{ suction?: number, water?: number, repeats?: number }} [options]
   */
  async startRoomClean(did, roomIds, options = {}) {
    const ids = [...new Set((Array.isArray(roomIds) ? roomIds : [roomIds])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0 && id < 64))];
    if (!ids.length) {
      throw new Error('No room selected');
    }
    const suction = Number.isInteger(options.suction) ? options.suction : SUCTION_LEVEL.standard;
    const water = Number.isInteger(options.water) ? options.water : WATER_LEVEL.medium;
    const repeats = Number.isInteger(options.repeats) && options.repeats > 0 ? options.repeats : 1;
    const kind = options.kind === 'mop' || options.kind === 'vac_mop' ? options.kind : 'vacuum';
    const current = await this.getProperties(did);
    if (Number(current.autoMountMop) === 1) {
      this._liftingDids.add(String(did));
    }
    if (kind === 'vacuum' && this._isDockMopCycle(current)) {
      this._log.info('stop dock mop cycle before room vacuum');
      await this.stop(did);
      await sleep(800);
    }
    const wire = this._cleaningModeValue(kind, did, current.rawCleaningMode);
    const meta = this._startMeta(kind, did, wire);
    this._log.info(
      `start room did=${meta.did} rooms=${ids.join(',')} model=${meta.model} style=${meta.style} wire=${wire} suction=${suction} water=${water}`,
    );
    await this.setCleaningMode(did, wire);
    const afterSet = await this.getProperties(did);
    const selects = ids.map((id) => [id, repeats, suction, water, 1]);
    await this.sendAction(did, MIOT_ACTIONS.startCustom, [
      { piid: 1, value: MovaStatus.SegmentCleaning },
      { piid: 10, value: JSON.stringify({ selects }) },
    ]);
    return { ...meta, afterSet, prevRaw: current.rawCleaningMode, rooms: ids };
  }

  async pause(did) {
    return this.sendAction(did, MIOT_ACTIONS.pauseClean);
  }

  async stop(did) {
    return this.sendAction(did, MIOT_ACTIONS.stopClean);
  }

  async dock(did) {
    return this.sendAction(did, MIOT_ACTIONS.charge);
  }

  async locate(did) {
    return this.sendAction(did, MIOT_ACTIONS.locate);
  }

  async setSuctionLevel(did, level) {
    if (!Object.prototype.hasOwnProperty.call(SUCTION_LEVEL, level)) {
      throw new Error(`Unknown MOVAhome suction level: ${level}`);
    }
    return this.sendCommand(did, 'set_properties', [{
      siid: MIOT_PROPERTIES.suctionLevel.siid,
      piid: MIOT_PROPERTIES.suctionLevel.piid,
      value: SUCTION_LEVEL[level],
    }]);
  }

  async setWaterLevel(did, level) {
    if (!Object.prototype.hasOwnProperty.call(WATER_LEVEL, level)) {
      throw new Error(`Unknown MOVAhome water level: ${level}`);
    }
    return this.sendCommand(did, 'set_properties', [{
      siid: MIOT_PROPERTIES.waterFlow.siid,
      piid: MIOT_PROPERTIES.waterFlow.piid,
      value: WATER_LEVEL[level],
    }]);
  }

  async setCleanGenius(did, level) {
    if (!Object.prototype.hasOwnProperty.call(CLEAN_GENIUS, level)) {
      throw new Error(`Unknown MOVAhome CleanGenius level: ${level}`);
    }
    return this.sendCommand(did, 'set_properties', [{
      siid: MIOT_PROPERTIES.autoSwitchSettings.siid,
      piid: MIOT_PROPERTIES.autoSwitchSettings.piid,
      value: JSON.stringify({
        k: AUTO_SWITCH_CLEAN_GENIUS_KEY,
        v: CLEAN_GENIUS[level],
      }),
    }]);
  }

  async startAutoEmpty(did) {
    return this.sendAction(did, MIOT_ACTIONS.startAutoEmpty);
  }

  async startWashing(did) {
    try {
      return await this.sendAction(did, MIOT_ACTIONS.startWashing, [
        { piid: 10, value: '2,1' },
      ]);
    } catch (_err) {
      return this.sendAction(did, MIOT_ACTIONS.startWashing);
    }
  }

  async getProperties(did) {
    const keys = statusPropertyKeysForModel(this._models.get(String(did)));
    const props = keys.map((key) => MIOT_PROPERTIES[key]);
    const data = await this.sendCommand(did, 'get_properties', props);
    const status = miotPropertiesToStatus(unwrapPropertyResults(data));
    if (Number(status.autoMountMop) === 1) {
      this._liftingDids.add(String(did));
    }
    status.rawCleaningMode = status.cleaningMode;
    if (status.cleaningMode !== undefined) {
      status.cleaningMode = this._logicalCleaningMode(did, status.cleaningMode);
    }
    return status;
  }

  async resetConsumable(did, consumableId) {
    const spec = CONSUMABLES[consumableId];
    if (!spec || !MIOT_ACTIONS[spec.resetAction]) {
      throw new Error(`Unknown MOVAhome consumable: ${consumableId}`);
    }
    return this.sendAction(did, MIOT_ACTIONS[spec.resetAction]);
  }

  async requestMap(did) {
    try {
      return await this.sendAction(did, MIOT_ACTIONS.requestMap);
    } catch (_err) {
      return this.sendAction(did, MIOT_ACTIONS.requestMap, [
        { piid: 2, value: '{"frame_type":"I","req_type":1}' },
      ]);
    }
  }

  _summarizeMapResults(results) {
    if (!Array.isArray(results)) {
      return [];
    }
    return results.map((item) => ({
      siid: item && item.siid,
      piid: item && item.piid,
      code: item && item.code,
      type: item && item.value === null ? 'null' : typeof (item && item.value),
      length: item && item.value !== undefined && item.value !== null ? String(item.value).length : 0,
    }));
  }

  async _getMapProperties(did) {
    const data = await this.sendCommand(did, 'get_properties', [
      MIOT_PROPERTIES.mapData,
      MIOT_PROPERTIES.mapObjectNameAlt,
      MIOT_PROPERTIES.mapObjectName,
      MIOT_PROPERTIES.mapExtendData,
      MIOT_PROPERTIES.mapList,
    ]);
    const results = unwrapPropertyResults(data);
    const objectName = objectNameFromValue(extractMapProperty(results, 6, 2))
      || objectNameFromValue(extractMapProperty(results, 6, 3))
      || objectNameFromValue(extractMapProperty(results, 6, 8))
      || objectNameFromMapList(extractMapProperty(results, 6, 8));
    const mapList = extractMapProperty(results, 6, 8);
    const meta = {
      mapData: extractMapProperty(results, 6, 1),
      objectName,
      objectNameAlt: extractMapProperty(results, 6, 2),
      mapExtend: extractMapProperty(results, 6, 4),
      mapList,
      debug: {
        properties: this._summarizeMapResults(results),
        mapList: mapList === undefined || mapList === null ? '' : String(mapList).slice(0, 240),
      },
    };
    this._lastMapMeta = meta;
    return meta;
  }

  async _getMapFromUserData(did) {
    const bodies = [
      { did, keys: ['map'] },
      { did, key: 'map' },
      { did, type: 'map' },
      { did, keys: ['I_map', 'map'] },
    ];
    for (const body of bodies) {
      try {
        const json = await this._api(GET_DEVICE_DATA_ENDPOINT, body);
        const data = json && json.data !== undefined ? json.data : json;
        const objectName = objectNameFromValue(data);
        if (objectName) {
          return objectName;
        }
      } catch (_err) {
        // try next body
      }
    }
    return '';
  }

  _extractDownloadUrl(json) {
    const seen = new Set();
    const visit = (value) => {
      if (!value || seen.has(value)) {
        return '';
      }
      if (typeof value === 'string') {
        return /^https?:\/\//.test(value) ? value : '';
      }
      if (typeof value !== 'object') {
        return '';
      }
      seen.add(value);
      const preferred = value.url || value.downloadUrl || value.download_url || value.signedUrl || value.fileUrl;
      if (typeof preferred === 'string' && /^https?:\/\//.test(preferred)) {
        return preferred;
      }
      for (const nested of Object.values(value)) {
        const found = visit(nested);
        if (found) {
          return found;
        }
      }
      return '';
    };
    return visit(json);
  }

  async downloadMapObject(did, objectName, model) {
    const filename = String(objectName || '').split(',')[0];
    if (!filename) {
      throw new Error('Missing MOVAhome map object name');
    }
    const uid = (this._session && this._session.uid) || '';
    const modelName = model || '';
    const bodies = [
      { did, model: modelName, filename, region: this.region },
      { did, uid, model: modelName, filename, region: this.region },
      { did, model: modelName, obj_name: filename, region: this.region },
      { did, model: modelName, objectName: filename, region: this.region },
    ];
    const endpoints = [MAP_DOWNLOAD_ENDPOINT, MAP_DOWNLOAD_ENDPOINT_ALT];
    let lastError = new Error('Map download URL missing');
    for (const endpoint of endpoints) {
      try {
        const query = new URLSearchParams({
          did,
          model: modelName,
          filename,
          region: this.region,
        });
        const json = await this._request(`${this._baseUrl()}${endpoint}?${query}`, {
          method: 'GET',
          headers: this._authHeaders('application/json'),
        });
        const url = this._extractDownloadUrl(json);
        if (url) {
          return this._downloadBinary(url);
        }
      } catch (error) {
        lastError = error;
      }
      for (const body of bodies) {
        try {
          const json = await this._api(endpoint, body);
          const url = this._extractDownloadUrl(json);
          if (!url) {
            lastError = new Error(`Map download URL missing (${endpoint})`);
            continue;
          }
          return this._downloadBinary(url);
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError;
  }

  async _decodeDownloadedMap(did, objectName, modelName, seen = new Set(), debug = null, wantRooms = false) {
    const filename = String(objectName || '').split(',')[0];
    if (!filename || seen.has(filename)) {
      return null;
    }
    seen.add(filename);
    const file = await this.downloadMapObject(did, filename, modelName);
    const head = Buffer.isBuffer(file) ? file.subarray(0, 24).toString('hex') : '';
    const ascii = Buffer.isBuffer(file) ? file.toString('utf8', 0, 80).replace(/[^\x20-\x7e]/g, '.') : '';
    const nested = objectNamesFromMapFile(file);
    if (debug) {
      debug.download = {
        filename,
        model: modelName || '',
        bytes: Buffer.isBuffer(file) ? file.length : 0,
        head,
        ascii,
        nested,
      };
    }
    const decoded = this._decodeMapData(file) || decodeSavedMapContainer(file);
    if (decoded && decoded.pixels && (!wantRooms || (decoded.rooms && decoded.rooms.length))) {
      return decoded;
    }
    let withPixels = decoded && decoded.pixels ? decoded : null;
    let rooms = decoded && decoded.rooms && decoded.rooms.length ? decoded.rooms : null;
    for (const name of nested) {
      try {
        const inner = await this._decodeDownloadedMap(did, name, modelName, seen, debug, wantRooms);
        if (inner && inner.rooms && inner.rooms.length) {
          rooms = inner.rooms;
        }
        if (inner && inner.pixels && !withPixels) {
          withPixels = inner;
        }
        if (withPixels && (!wantRooms || rooms)) {
          break;
        }
      } catch (error) {
        this._log.warn(`Nested map ${name} failed: ${error.message}`);
        if (debug) {
          debug.download = { ...(debug.download || {}), nestedError: error.message };
        }
      }
    }
    const result = withPixels || decoded;
    if (result && rooms && (!result.rooms || !result.rooms.length)) {
      result.rooms = rooms;
    }
    return result;
  }

  async _downloadBinary(url) {
    if (typeof this._download === 'function') {
      return this._download(url);
    }
    if (typeof fetch === 'function') {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`MOVAhome map download HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
    throw new Error('Map download requires fetch()');
  }

  async getMapView(did, { model, wantRooms = false } = {}) {
    const deviceId = String(did);
    const modelName = model || this._models.get(deviceId) || '';
    const previous = this._mapFrames.get(deviceId) || null;
    let meta = { mapData: undefined, objectName: '', mapList: undefined };
    try {
      meta = await this._getMapProperties(did);
    } catch (error) {
      this._log.warn(`Map properties failed: ${error.message}`);
      meta.mapError = error.message;
    }

    this._log.info(
      `Map props objectName=${meta.objectName || '-'} mapData=${meta.mapData ? String(meta.mapData).length : 0}`,
    );

    let decoded = this._decodeMapData(meta.mapData);
    const needsFloor = !decoded || decoded.frameType === 'P' || !decoded.pixels;
    if (needsFloor && !previous && !meta.objectName && !this._mapRequested.has(deviceId)) {
      this._mapRequested.add(deviceId);
      try {
        await this.requestMap(did);
        await sleep(800);
        meta = await this._getMapProperties(did);
        decoded = this._decodeMapData(meta.mapData) || decoded;
        this._log.info(
          `Map after request objectName=${meta.objectName || '-'} mapData=${meta.mapData ? String(meta.mapData).length : 0}`,
        );
      } catch (error) {
        this._log.warn(`Map request failed: ${error.message}`);
      }
    }

    if (!meta.objectName) {
      try {
        meta.objectName = await this._getMapFromUserData(did) || meta.objectName;
      } catch (error) {
        this._log.warn(`Map user data failed: ${error.message}`);
      }
    }

    if ((!decoded || decoded.frameType === 'P' || !decoded.pixels) && meta.objectName) {
      try {
        const fromFile = await this._decodeDownloadedMap(did, meta.objectName, modelName, new Set(), meta.debug);
        if (fromFile && fromFile.pixels) {
          if (decoded && decoded.robot) {
            fromFile.robot = decoded.robot;
            fromFile.charger = decoded.charger || fromFile.charger;
            fromFile.path = decoded.path && decoded.path.length ? decoded.path : fromFile.path;
          }
          decoded = fromFile;
        } else if (fromFile && fromFile.robot) {
          decoded = fromFile;
        }
      } catch (error) {
        this._log.warn(`Map file download failed: ${error.message}`);
        if (meta.debug && typeof meta.debug === 'object' && !Array.isArray(meta.debug)) {
          meta.debug.downloadError = error.message;
        }
      }
    }

    const roomSources = [];
    if (decoded && decoded.extra) {
      roomSources.push({ from: 'live', ...describeMapExtra(decoded.extra) });
    }
    if (meta.mapExtend) {
      roomSources.push({
        from: 'extend',
        value: String(meta.mapExtend).slice(0, 500),
      });
    }
    if (wantRooms) {
      const names = [];
      const pushName = (value) => {
        const name = String(value || '').split(',')[0];
        if (name && !names.includes(name) && !name.startsWith('{') && !name.startsWith('[')) {
          names.push(name);
        }
      };
      pushName(meta.objectNameAlt);
      pushName(meta.objectName);
      pushName(objectNameFromValue(meta.mapList) || objectNameFromMapList(meta.mapList));
      let merged = (decoded && decoded.rooms) || [];
      for (const name of names) {
        try {
          const fromFile = await this._decodeDownloadedMap(did, name, modelName, new Set(), meta.debug, true);
          if (fromFile && fromFile.extra) {
            roomSources.push({ from: name, ...describeMapExtra(fromFile.extra) });
          }
          if (fromFile && fromFile.rooms && fromFile.rooms.length) {
            merged = mergeRooms(merged, fromFile.rooms);
            if (!decoded) {
              decoded = fromFile;
            }
          }
        } catch (error) {
          this._log.warn(`Room map ${name} failed: ${error.message}`);
          roomSources.push({ from: name, error: error.message });
        }
      }
      if (decoded) {
        decoded.rooms = merged;
      }
    }

    if (!decoded && !previous) {
      const empty = serializeMapView({ ok: false, error: meta.mapError || 'No map data' });
      empty.debug = meta.debug;
      empty.objectName = meta.objectName || '';
      empty.rooms = [];
      empty.roomSources = roomSources;
      empty.mapError = meta.mapError || '';
      return empty;
    }

    const view = toViewModel(decoded, previous);
    if (view.ok) {
      this._mapFrames.set(deviceId, view);
    }
    view.debug = meta.debug;
    view.objectName = meta.objectName || '';
    view.roomSources = roomSources;
    view.mapError = meta.mapError || '';
    return view;
  }

  _decodeMapData(mapData) {
    if (!mapData) {
      return null;
    }
    try {
      return decodeMapPayload(mapData);
    } catch (error) {
      this._log.warn(`Map frame decode failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = {
  MovaCloudClient,
  hashPassword,
};
