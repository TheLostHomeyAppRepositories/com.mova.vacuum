'use strict';

/** MOVAhome password salt used by reverse-engineered connectors (matterbridge-mova, ioBroker.dreame). */
const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq';

/** Basic auth for dreame_appv1 (same header on MOVAhome and Dreamehome). */
const AUTH_BASIC = 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=';

const CLIENT_ID = 'dreame_appv1';
const TENANT_ID = '000002';
const API_DOMAIN = '.iot.mova-tech.com';
const API_PORT = '13267';
const USER_AGENT = 'Mova_Smarthome/1.2.4 (iPhone; iOS 18.4.1; Scale/3.00)';

const AUTH_ENDPOINT = '/dreame-auth/oauth/token';
const DEVICE_LIST_ENDPOINT = '/dreame-user-iot/iotuserbind/device/listV2';
const GET_DEVICE_DATA_ENDPOINT = '/dreame-user-iot/iotuserdata/getDeviceData';
const SET_DEVICE_DATA_ENDPOINT = '/dreame-user-iot/iotuserdata/setDeviceData';
const MAP_DOWNLOAD_ENDPOINT = '/dreame-user-iot/iotfile/getDownloadUrl';
const MAP_DOWNLOAD_ENDPOINT_ALT = '/dreame-user-iot/iotfile/getOss1dDownloadUrl';

const REGIONS = ['cn', 'eu', 'us', 'sg', 'ru'];

const MIOT_PROPERTIES = {
  operatingMode: { siid: 2, piid: 1 },
  deviceFault: { siid: 2, piid: 2 },
  batteryLevel: { siid: 3, piid: 1 },
  chargingState: { siid: 3, piid: 2 },
  deviceStatus: { siid: 4, piid: 1 },
  cleaningTime: { siid: 4, piid: 2 },
  cleanedArea: { siid: 4, piid: 3 },
  suctionLevel: { siid: 4, piid: 4 },
  waterFlow: { siid: 4, piid: 5 },
  waterTank: { siid: 4, piid: 6 },
  taskStatus: { siid: 4, piid: 7 },
  cleaningMode: { siid: 4, piid: 23 },
  autoSwitchSettings: { siid: 4, piid: 50 },
  mopPadInstalled: { siid: 4, piid: 53 },
  mainBrushLeft: { siid: 9, piid: 2 },
  sideBrushLeft: { siid: 10, piid: 2 },
  filterLeft: { siid: 11, piid: 1 },
  sensorLeft: { siid: 16, piid: 1 },
  mopPadLeft: { siid: 18, piid: 1 },
  mapData: { siid: 6, piid: 1 },
  mapObjectName: { siid: 6, piid: 3 },
  mapList: { siid: 6, piid: 8 },
};

const MIOT_ACTIONS = {
  startClean: { siid: 2, aiid: 1 },
  pauseClean: { siid: 2, aiid: 2 },
  charge: { siid: 3, aiid: 1 },
  startCustom: { siid: 4, aiid: 1 },
  stopClean: { siid: 4, aiid: 2 },
  startWashing: { siid: 4, aiid: 4 },
  locate: { siid: 7, aiid: 1 },
  startAutoEmpty: { siid: 15, aiid: 1 },
  resetMainBrush: { siid: 9, aiid: 1 },
  resetSideBrush: { siid: 10, aiid: 1 },
  resetFilter: { siid: 11, aiid: 1 },
  resetSensor: { siid: 16, aiid: 1 },
  resetMopPad: { siid: 18, aiid: 1 },
  requestMap: { siid: 6, aiid: 1 },
};

const CONSUMABLE_LOW_PERCENT = 20;

const CONSUMABLES = {
  mainBrush: {
    property: 'mainBrushLeft',
    capability: 'measure_main_brush',
    resetAction: 'resetMainBrush',
  },
  sideBrush: {
    property: 'sideBrushLeft',
    capability: 'measure_side_brush',
    resetAction: 'resetSideBrush',
  },
  filter: {
    property: 'filterLeft',
    capability: 'measure_filter',
    resetAction: 'resetFilter',
  },
  mopPad: {
    property: 'mopPadLeft',
    capability: 'measure_mop',
    resetAction: 'resetMopPad',
  },
  sensor: {
    property: 'sensorLeft',
    capability: 'measure_sensor',
    resetAction: 'resetSensor',
  },
};

/**
 * Cleaning-mode values (siid=4, piid=23) on Dreame / MOVA V70 firmware:
 * 0 = vacuum, 1 = mop, 2 = vacuum+mop, 3 = vacuum then mop.
 * Some S70 Roller units invert 0 and 2 on the wire (vacuum ↔ vacuum+mop).
 */
const CLEANING_MODE = {
  VACUUM: 0,
  MOP: 1,
  VACUUM_AND_MOP: 2,
  VACUUM_THEN_MOP: 3,
};

const CLEANING_MODE_S70 = {
  VACUUM_AND_MOP: 0,
  MOP: 1,
  VACUUM: 2,
  VACUUM_THEN_MOP: 3,
};

function usesSwappedCleaningMode(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('vacuum.s70');
}

/** Suction (siid=4, piid=4): 0 Quiet, 1 Standard, 2 Strong, 3 Turbo. */
const SUCTION_LEVEL = {
  quiet: 0,
  standard: 1,
  strong: 2,
  turbo: 3,
};

/** Water / mop wetness (siid=4, piid=5): 1 Low, 2 Medium, 3 High. */
const WATER_LEVEL = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * CleanGenius (AutoSwitch SmartHost in siid=4, piid=50).
 * Write `{"k":"SmartHost","v":0|1|2}`. 0 Off, 1 Routine, 2 Deep.
 */
const CLEAN_GENIUS = {
  off: 0,
  routine: 1,
  deep: 2,
};

const AUTO_SWITCH_CLEAN_GENIUS_KEY = 'SmartHost';

/**
 * Battery charging-state (siid=3, piid=2).
 * Dreame / MOVA V70: 1 charging, 2 not charging, 3 completed, 5 returning.
 */
const CHARGING_STATE = {
  Charging: 1,
  NotCharging: 2,
  Completed: 3,
  Charging2: 4,
  GoCharging: 5,
};

/**
 * Task status (siid=4, piid=7). 0 means the last job is finished.
 * 1–5 are active jobs; 6+ are paused variants.
 */
const TASK_STATUS = {
  Completed: 0,
  Auto: 1,
  Zone: 2,
  Segment: 3,
  Spot: 4,
  FastMapping: 5,
};

/**
 * Dreame-style operating mode (siid=2, piid=1) used by V70 / X40 / X50.
 * Value 2 is Idle here, but Cleaning in MovaState — never treat 2 as cleaning
 * unless device status / charging-state also say the robot is running.
 */
const DreameState = {
  Sweeping: 1,
  Idle: 2,
  Paused: 3,
  Error: 4,
  Returning: 5,
  Charging: 6,
  Mopping: 7,
  Drying: 8,
  Washing: 9,
  ReturningWashing: 10,
  Building: 11,
  SweepingAndMopping: 12,
  ChargingCompleted: 13,
  Upgrading: 14,
};

/** Operating mode (siid=2, piid=1) — MovaState in matterbridge-mova. */
const MovaState = {
  Unknown: -1,
  Idle: 0,
  Paused: 1,
  Cleaning: 2,
  GoCharging: 3,
  Error: 4,
  Mopping: 5,
  Charging: 6,
  Drying: 7,
  Dormant: 8,
  Washing: 9,
  Returning: 10,
  Defecating: 11,
  Building: 12,
  ManualCleaning: 13,
  Sleeping: 14,
  WaitingForTask: 15,
  StationPaused: 16,
  ManualPaused: 17,
  ZonedPaused: 18,
  ZonedCleaning: 19,
  SpotCleaning: 20,
  FastMapping: 21,
  CruiseWaiting: 22,
  CruiseRunning: 23,
  SecondCleaning: 24,
  HumanFollowing: 25,
  SpotCleaningPaused: 26,
  ReturningAutoEmpty: 27,
  CleaningAutoEmpty: 28,
  StationCleaning: 29,
  ReturningToDrain: 30,
  Draining: 31,
  AutoWaterDraining: 32,
  Emptying: 33,
  DustBagDrying: 34,
  DustBagDryingPaused: 35,
};

/** Device status (siid=4, piid=1) — MovaStatus in matterbridge-mova. */
const MovaStatus = {
  Unknown: -1,
  Idle: 0,
  Paused: 1,
  Cleaning: 2,
  BackHome: 3,
  PartCleaning: 4,
  FollowWall: 5,
  Charging: 6,
  OTA: 7,
  FCT: 8,
  WifiSet: 9,
  PowerOff: 10,
  Factory: 11,
  Error: 12,
  RemoteControl: 13,
  Sleeping: 14,
  SelfRepair: 15,
  FactoryTest: 16,
  Standby: 17,
  SegmentCleaning: 18,
  ZoneCleaning: 19,
  SpotCleaning: 20,
  FastMapping: 21,
  CruisingPath: 22,
  CruisingPoint: 23,
  SummonClean: 24,
  Shortcut: 25,
  PersonFollow: 26,
  Sweeping: 101,
  Mopping: 102,
  SweepingAndMopping: 103,
  Drying: 104,
  Washing: 105,
  ReturningWashing: 106,
  Building: 107,
  ChargingComplete: 108,
  Upgrading: 109,
  CleanSummarizing: 110,
  StationReset: 111,
  ReturningDrain: 112,
  SelfRepairing: 113,
  SelfWashing: 114,
  BackWashing: 115,
  SelfRefresh: 116,
  SelfDrying: 117,
  WaterCheckStart: 118,
  WaterDraining: 119,
  DryingStart: 120,
  AutoEmptying: 121,
  FillingWater: 122,
};

function normalizeRegion(region) {
  const value = String(region || 'eu').trim().toLowerCase();
  return REGIONS.includes(value) ? value : 'eu';
}

function getApiBaseUrl(region) {
  return `https://${normalizeRegion(region)}${API_DOMAIN}:${API_PORT}`;
}

function getSendCommandPath(bindDomain) {
  const shard = (bindDomain && String(bindDomain).split('.', 1)[0]) || 'eu';
  return `/dreame-iot-com-${shard}/device/sendCommand`;
}

function isPairableVacuumModel(model) {
  return typeof model === 'string' && model.startsWith('mova.vacuum');
}

module.exports = {
  PASSWORD_SALT,
  AUTH_BASIC,
  CLIENT_ID,
  TENANT_ID,
  API_DOMAIN,
  API_PORT,
  USER_AGENT,
  AUTH_ENDPOINT,
  DEVICE_LIST_ENDPOINT,
  GET_DEVICE_DATA_ENDPOINT,
  SET_DEVICE_DATA_ENDPOINT,
  MAP_DOWNLOAD_ENDPOINT,
  MAP_DOWNLOAD_ENDPOINT_ALT,
  REGIONS,
  MIOT_PROPERTIES,
  MIOT_ACTIONS,
  CONSUMABLE_LOW_PERCENT,
  CONSUMABLES,
  CLEANING_MODE,
  CLEANING_MODE_S70,
  usesSwappedCleaningMode,
  SUCTION_LEVEL,
  WATER_LEVEL,
  CLEAN_GENIUS,
  AUTO_SWITCH_CLEAN_GENIUS_KEY,
  CHARGING_STATE,
  TASK_STATUS,
  DreameState,
  MovaState,
  MovaStatus,
  normalizeRegion,
  getApiBaseUrl,
  getSendCommandPath,
  isPairableVacuumModel,
};
