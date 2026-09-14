'use strict';

const { modelMatchesFamily } = require('./constants');

function extractDeviceRecords(listV2Body) {
  if (!listV2Body || typeof listV2Body !== 'object') {
    return [];
  }
  const data = listV2Body.data;
  const records = (data && data.page && data.page.records)
    || (data && data.records)
    || (data && data.list)
    || listV2Body.records
    || [];
  return Array.isArray(records) ? records : [];
}

function recordModel(record) {
  if (!record || typeof record !== 'object') {
    return '';
  }
  if (typeof record.model === 'string' && record.model) {
    return record.model;
  }
  const info = record.deviceInfo;
  if (info && typeof info.model === 'string' && info.model) {
    return info.model;
  }
  return '';
}

function listV2ModelSummary(listV2Body) {
  const records = extractDeviceRecords(listV2Body);
  return {
    count: records.length,
    models: records.map((record) => recordModel(record) || '(unknown)'),
  };
}

function toPairableVacuum(record, family = 'mova') {
  const model = recordModel(record);
  if (!record || !modelMatchesFamily(model, family)) {
    return null;
  }
  const displayName = (record.deviceInfo && record.deviceInfo.displayName) || record.name;
  return {
    did: String(record.did),
    name: record.customName || displayName || `MOVA ${model}`,
    model,
    mac: record.mac || '',
    online: Boolean(record.online),
    bindDomain: record.bindDomain || '',
    masterUid: record.masterUid || record.uid || '',
  };
}

function filterPairableVacuums(records, family = 'mova') {
  if (!Array.isArray(records)) {
    return [];
  }
  return records.map((record) => toPairableVacuum(record, family)).filter(Boolean);
}

function vacuumsFromListV2(listV2Body, family = 'mova') {
  return filterPairableVacuums(extractDeviceRecords(listV2Body), family);
}

function toHomeyStoreDevice(device, credentials) {
  const { username, password, region } = credentials;
  const session = credentials.session || {};
  return {
    name: device.name,
    data: {
      id: device.did,
    },
    store: {
      username,
      password: password || '',
      region,
      model: device.model,
      bindDomain: device.bindDomain,
      masterUid: device.masterUid,
      mac: device.mac,
      accessToken: session.accessToken || '',
      refreshToken: session.refreshToken || '',
      expiresAt: session.expiresAt || 0,
      uid: session.uid || '',
    },
  };
}

function toHomeyPairingDevices(listV2Body, credentials) {
  const family = credentials && credentials.family === 'dreame' ? 'dreame' : 'mova';
  return vacuumsFromListV2(listV2Body, family).map((device) => toHomeyStoreDevice(device, credentials));
}

module.exports = {
  extractDeviceRecords,
  recordModel,
  listV2ModelSummary,
  toPairableVacuum,
  filterPairableVacuums,
  vacuumsFromListV2,
  toHomeyStoreDevice,
  toHomeyPairingDevices,
};
