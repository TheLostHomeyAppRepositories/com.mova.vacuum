'use strict';

const {
  CLEANING_MODE,
  CONSUMABLE_LOW_PERCENT,
  CHARGING_STATE,
  TASK_STATUS,
  DreameState,
  MovaState,
  MovaStatus,
  SUCTION_LEVEL,
  WATER_LEVEL,
  CLEAN_GENIUS,
  AUTO_SWITCH_CLEAN_GENIUS_KEY,
} = require('./constants');

const SUCTION_LEVEL_BY_VALUE = Object.fromEntries(
  Object.entries(SUCTION_LEVEL).map(([name, value]) => [value, name]),
);
const WATER_LEVEL_BY_VALUE = Object.fromEntries(
  Object.entries(WATER_LEVEL).map(([name, value]) => [value, name]),
);
const CLEAN_GENIUS_BY_VALUE = Object.fromEntries(
  Object.entries(CLEAN_GENIUS).map(([name, value]) => [value, name]),
);

const OPERATIONAL_STATUS = {
  CLEANING: 'cleaning',
  MOPPING: 'mopping',
  VACUUM_AND_MOP: 'vacuum_and_mop',
  PAUSED: 'paused',
  RETURNING: 'returning',
  DOCKED: 'docked',
  CHARGING: 'charging',
  STOPPED: 'stopped',
};

const ACTIVE_CLEANING_STATES = new Set([
  MovaState.Cleaning,
  MovaState.Mopping,
  MovaState.ZonedCleaning,
  MovaState.SpotCleaning,
  MovaState.ManualCleaning,
  MovaState.CruiseRunning,
  MovaState.SecondCleaning,
  MovaState.CleaningAutoEmpty,
  MovaState.HumanFollowing,
]);

const ACTIVE_CLEANING_STATUSES = new Set([
  MovaStatus.Cleaning,
  MovaStatus.PartCleaning,
  MovaStatus.FollowWall,
  MovaStatus.SegmentCleaning,
  MovaStatus.ZoneCleaning,
  MovaStatus.SpotCleaning,
  MovaStatus.Sweeping,
  MovaStatus.Mopping,
  MovaStatus.SweepingAndMopping,
  MovaStatus.SummonClean,
  MovaStatus.Shortcut,
]);

const PAUSED_STATES = new Set([
  MovaState.Paused,
  MovaState.StationPaused,
  MovaState.ManualPaused,
  MovaState.ZonedPaused,
  MovaState.SpotCleaningPaused,
  MovaState.DustBagDryingPaused,
]);

const TASK_STATUS_PAUSED = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 23, 24]);
const TASK_STATUS_ACTIVE = new Set([
  TASK_STATUS.Auto,
  TASK_STATUS.Zone,
  TASK_STATUS.Segment,
  TASK_STATUS.Spot,
  TASK_STATUS.FastMapping,
  20,
  22,
]);

const MOPPING_STATES = new Set([MovaState.Mopping]);
const MOPPING_STATUSES = new Set([MovaStatus.Mopping]);

const CHARGING_STATES = new Set([MovaState.Charging]);
const CHARGING_STATUSES = new Set([MovaStatus.Charging]);
const AT_DOCK_CHARGING_STATES = new Set([
  CHARGING_STATE.Charging,
  CHARGING_STATE.Completed,
  CHARGING_STATE.Charging2,
]);

const DOCKED_STATUSES = new Set([
  MovaStatus.Idle,
  MovaStatus.Sleeping,
  MovaStatus.Standby,
  MovaStatus.ChargingComplete,
  MovaStatus.Drying,
  MovaStatus.Washing,
  MovaStatus.SelfWashing,
  MovaStatus.SelfDrying,
  MovaStatus.AutoEmptying,
  MovaStatus.FillingWater,
  MovaStatus.CleanSummarizing,
  MovaStatus.StationReset,
  MovaStatus.WaterDraining,
  MovaStatus.DryingStart,
  MovaStatus.BackWashing,
]);

const DOCKED_STATES = new Set([
  MovaState.Idle,
  MovaState.Drying,
  MovaState.Dormant,
  MovaState.Washing,
  MovaState.Sleeping,
  MovaState.WaitingForTask,
  MovaState.Defecating,
  MovaState.Emptying,
  MovaState.Draining,
  MovaState.StationCleaning,
  MovaState.DustBagDrying,
  MovaState.AutoWaterDraining,
]);

const RETURNING_STATES = new Set([
  MovaState.Returning,
  MovaState.GoCharging,
  MovaState.ReturningAutoEmpty,
  MovaState.ReturningToDrain,
]);

const RETURNING_STATUSES = new Set([
  MovaStatus.BackHome,
  MovaStatus.ReturningWashing,
  MovaStatus.ReturningDrain,
]);

const STOPPED_STATUSES = new Set([
  MovaStatus.PowerOff,
  MovaStatus.OTA,
  MovaStatus.Factory,
  MovaStatus.WifiSet,
  MovaStatus.Upgrading,
]);

/**
 * Fault codes (siid=2, piid=2) that are dock/mop reminders, not a robot problem.
 * Homey `alarm_generic` must stay off for these or every finished mop job
 * shows "Algemeen alarm" while the V70 sits charging.
 * 68 = mopping completed / empty dirty water (Dreame #1475).
 */
const INFORMATIONAL_FAULT_CODES = new Set([
  0,
  30,
  38,
  44,
  46,
  54,
  56,
  57,
  61,
  68,
  69,
  70,
  71,
  72,
  74,
  75,
]);

function clampBattery(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return null;
  }
  return Math.round(n);
}

function clampNonNegative(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return Math.round(n);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isCleaningStatus(status) {
  return ACTIVE_CLEANING_STATUSES.has(status);
}

function isAtDockCharge(chargingState) {
  return AT_DOCK_CHARGING_STATES.has(chargingState);
}

function isJobCompleted(taskStatus) {
  return taskStatus === TASK_STATUS.Completed;
}

function isJobActive(taskStatus) {
  return TASK_STATUS_ACTIVE.has(taskStatus);
}

function isJobPaused(taskStatus) {
  return TASK_STATUS_PAUSED.has(taskStatus);
}

/**
 * V70 / Dreame firmware uses 1-indexed operating modes (Idle=2).
 * matterbridge-mova uses 0-indexed (Cleaning=2). Status + charging-state
 * tell those two meanings of `2` (and 1/3/5/7/12/13) apart.
 */
function isIdleAtDock({ state, status, chargingState, taskStatus }) {
  if (isJobActive(taskStatus)) {
    return false;
  }
  if (isAtDockCharge(chargingState)) {
    return true;
  }
  if (DOCKED_STATUSES.has(status) || CHARGING_STATUSES.has(status)) {
    return true;
  }
  if (state === DreameState.ChargingCompleted && !isCleaningStatus(status)) {
    return true;
  }
  if (state === DreameState.Idle && isJobCompleted(taskStatus)) {
    return true;
  }
  return false;
}

function isPaused({ state, status, taskStatus }) {
  if (isCleaningStatus(status) && !isJobPaused(taskStatus)) {
    return false;
  }
  if (status === MovaStatus.Paused || isJobPaused(taskStatus)) {
    return true;
  }
  if (state === DreameState.Paused && !RETURNING_STATUSES.has(status)) {
    return true;
  }
  if (PAUSED_STATES.has(state) && state !== MovaState.Paused) {
    return true;
  }
  if (state === MovaState.Paused && (status === MovaStatus.Paused || status === MovaStatus.Unknown)) {
    return true;
  }
  return false;
}

function isReturning({ state, status, chargingState }) {
  if (chargingState === CHARGING_STATE.GoCharging) {
    return true;
  }
  if (RETURNING_STATUSES.has(status)) {
    return true;
  }
  if (state === DreameState.Returning && !MOPPING_STATUSES.has(status) && !isCleaningStatus(status)) {
    return true;
  }
  if (RETURNING_STATES.has(state) && state !== MovaState.GoCharging) {
    return true;
  }
  if (state === MovaState.GoCharging && !isPaused({ state, status })) {
    return true;
  }
  return false;
}

function isCharging({ state, status, chargingState }) {
  if (chargingState === CHARGING_STATE.Charging || chargingState === CHARGING_STATE.Charging2) {
    return true;
  }
  if (CHARGING_STATUSES.has(status) || CHARGING_STATES.has(state)) {
    return true;
  }
  return false;
}

const CLEANING_KIND_STATUSES = new Set([
  MovaStatus.Sweeping,
  MovaStatus.Mopping,
  MovaStatus.SweepingAndMopping,
]);

function isLiveCleaningStatus(status) {
  return isCleaningStatus(status) && !CLEANING_KIND_STATUSES.has(status);
}

function isActivelyCleaning({ state, status, chargingState, taskStatus }) {
  if (isAtDockCharge(chargingState) && !isJobActive(taskStatus)) {
    return false;
  }
  if (DOCKED_STATUSES.has(status) || CHARGING_STATUSES.has(status)) {
    return false;
  }
  if (isJobCompleted(taskStatus) && !isLiveCleaningStatus(status)) {
    return false;
  }
  if (isJobActive(taskStatus)) {
    return true;
  }
  if (isLiveCleaningStatus(status) && chargingState !== CHARGING_STATE.Charging && chargingState !== CHARGING_STATE.Completed) {
    return true;
  }
  if (state === DreameState.Sweeping || state === DreameState.Mopping || state === DreameState.SweepingAndMopping) {
    return true;
  }
  if (state === MovaState.Cleaning) {
    if (isAtDockCharge(chargingState) || isJobCompleted(taskStatus) || DOCKED_STATUSES.has(status) || CHARGING_STATUSES.has(status)) {
      return false;
    }
    if (isLiveCleaningStatus(status) || CLEANING_KIND_STATUSES.has(status)) {
      return chargingState !== CHARGING_STATE.Charging && chargingState !== CHARGING_STATE.Completed;
    }
    return false;
  }
  if (ACTIVE_CLEANING_STATES.has(state) && state !== MovaState.Cleaning && !isAtDockCharge(chargingState)) {
    return true;
  }
  return false;
}

function isMopActive({ waterTank, mopPadInstalled } = {}) {
  if (mopPadInstalled === true || Number(mopPadInstalled) === 1) {
    return true;
  }
  if (Number(waterTank) === 10) {
    return true;
  }
  if (mopPadInstalled === false || Number(mopPadInstalled) === 0 || Number(waterTank) === 0) {
    return false;
  }
  return null;
}

function mapActiveCleaningKind({
  state,
  status,
  cleaningMode,
  waterTank,
  mopPadInstalled,
}) {
  if (status === MovaStatus.SweepingAndMopping || state === DreameState.SweepingAndMopping) {
    return OPERATIONAL_STATUS.VACUUM_AND_MOP;
  }
  if (MOPPING_STATUSES.has(status) || state === DreameState.Mopping) {
    return OPERATIONAL_STATUS.MOPPING;
  }
  if (status === MovaStatus.Sweeping || state === DreameState.Sweeping) {
    return OPERATIONAL_STATUS.CLEANING;
  }
  if (MOPPING_STATES.has(state) && isCleaningStatus(status)) {
    return OPERATIONAL_STATUS.MOPPING;
  }

  const mode = Number(cleaningMode);
  if (mode === CLEANING_MODE.MOP) {
    return OPERATIONAL_STATUS.MOPPING;
  }
  // Logical 0 = vacuum only. Combo-dock robots keep mop pads mounted (lifted),
  // so mopPadInstalled must not override an explicit vacuum mode.
  if (cleaningMode !== undefined && cleaningMode !== null && mode === CLEANING_MODE.VACUUM) {
    return OPERATIONAL_STATUS.CLEANING;
  }

  const mopActive = isMopActive({ waterTank, mopPadInstalled });
  if (mopActive === true) {
    return OPERATIONAL_STATUS.VACUUM_AND_MOP;
  }
  // Logical 2 = vacuum+mop. If mop hardware is explicitly off, keep vacuum-only.
  if (mode === CLEANING_MODE.VACUUM_AND_MOP || mode === CLEANING_MODE.VACUUM_THEN_MOP) {
    return mopActive === false ? OPERATIONAL_STATUS.CLEANING : OPERATIONAL_STATUS.VACUUM_AND_MOP;
  }
  return OPERATIONAL_STATUS.CLEANING;
}

function mapOperationalStatus({
  state,
  status,
  chargingState,
  taskStatus,
  cleaningMode,
  waterTank,
  mopPadInstalled,
} = {}) {
  const s = toNumber(state, MovaState.Unknown);
  const st = toNumber(status, MovaStatus.Unknown);
  const charge = toNumber(chargingState, NaN);
  const task = toNumber(taskStatus, NaN);
  const signals = {
    state: s,
    status: st,
    chargingState: charge,
    taskStatus: task,
  };

  if (isPaused(signals)) {
    return OPERATIONAL_STATUS.PAUSED;
  }

  if (isReturning(signals) && !isIdleAtDock(signals)) {
    return OPERATIONAL_STATUS.RETURNING;
  }

  const stationBusy = DOCKED_STATUSES.has(st)
    && st !== MovaStatus.Idle
    && st !== MovaStatus.Sleeping
    && st !== MovaStatus.Standby
    && st !== MovaStatus.ChargingComplete;
  if (stationBusy) {
    return OPERATIONAL_STATUS.DOCKED;
  }

  if (isCharging(signals)) {
    return OPERATIONAL_STATUS.CHARGING;
  }

  if (isIdleAtDock(signals)) {
    if (charge === CHARGING_STATE.Charging || charge === CHARGING_STATE.Charging2 || CHARGING_STATUSES.has(st) || CHARGING_STATES.has(s)) {
      return OPERATIONAL_STATUS.CHARGING;
    }
    return OPERATIONAL_STATUS.DOCKED;
  }

  if (isActivelyCleaning(signals)) {
    return mapActiveCleaningKind({
      state: s,
      status: st,
      cleaningMode,
      waterTank,
      mopPadInstalled,
    });
  }

  if (DOCKED_STATUSES.has(st) || DOCKED_STATES.has(s)) {
    return OPERATIONAL_STATUS.DOCKED;
  }

  if (STOPPED_STATUSES.has(st) || s === MovaState.Error || st === MovaStatus.Error || s === DreameState.Error) {
    return OPERATIONAL_STATUS.STOPPED;
  }

  if (s === MovaState.Unknown && st === MovaStatus.Unknown) {
    return OPERATIONAL_STATUS.STOPPED;
  }

  return OPERATIONAL_STATUS.STOPPED;
}

function mapOnoff(operationalStatus, { state } = {}) {
  if (state === MovaState.StationPaused || state === MovaState.DustBagDryingPaused) {
    return false;
  }
  return operationalStatus === OPERATIONAL_STATUS.CLEANING
    || operationalStatus === OPERATIONAL_STATUS.MOPPING
    || operationalStatus === OPERATIONAL_STATUS.VACUUM_AND_MOP
    || operationalStatus === OPERATIONAL_STATUS.PAUSED;
}

function mapSuctionLevel(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const mapped = SUCTION_LEVEL_BY_VALUE[Number(value)];
  return mapped || null;
}

function mapWaterLevel(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const mapped = WATER_LEVEL_BY_VALUE[Number(value)];
  return mapped || null;
}

function parseAutoSwitchSettings(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return {};
  }
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return {};
    }
  }
  if (Array.isArray(parsed)) {
    const out = {};
    for (const item of parsed) {
      if (item && item.k !== undefined) {
        out[item.k] = item.v;
      }
    }
    return out;
  }
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  if (parsed.k !== undefined && parsed.v !== undefined && Object.keys(parsed).length <= 3) {
    return { [parsed.k]: parsed.v };
  }
  return parsed;
}

function mapCleanGenius(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLEAN_GENIUS, value)) {
    return value;
  }
  const settings = parseAutoSwitchSettings(value);
  const raw = settings[AUTO_SWITCH_CLEAN_GENIUS_KEY] !== undefined
    ? settings[AUTO_SWITCH_CLEAN_GENIUS_KEY]
    : value;
  if (raw === undefined || raw === null || typeof raw === 'object') {
    return null;
  }
  const mapped = CLEAN_GENIUS_BY_VALUE[Number(raw)];
  return mapped || null;
}

function mapVacuumcleanerState(operationalStatus) {
  switch (operationalStatus) {
    case OPERATIONAL_STATUS.CLEANING:
    case OPERATIONAL_STATUS.MOPPING:
    case OPERATIONAL_STATUS.VACUUM_AND_MOP:
      return 'cleaning';
    case OPERATIONAL_STATUS.CHARGING:
      return 'charging';
    case OPERATIONAL_STATUS.DOCKED:
      return 'docked';
    case OPERATIONAL_STATUS.RETURNING:
    case OPERATIONAL_STATUS.PAUSED:
    case OPERATIONAL_STATUS.STOPPED:
    default:
      return 'stopped';
  }
}

/**
 * Map MIOT battery + operating mode / device status onto Homey-facing values.
 */
function extractConsumables(raw = {}) {
  return {
    mainBrush: clampPercent(raw.mainBrush),
    sideBrush: clampPercent(raw.sideBrush),
    filter: clampPercent(raw.filter),
    mopPad: clampPercent(raw.mopPad),
    sensor: clampPercent(raw.sensor),
  };
}

function isConsumableLow(consumables = {}) {
  return Object.values(consumables).some((value) => value !== null && value <= CONSUMABLE_LOW_PERCENT);
}

function isDeviceAlarm(errorCode) {
  const n = Number(errorCode);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }
  return !INFORMATIONAL_FAULT_CODES.has(n);
}

function mapDeviceStatusToHomey({
  battery,
  state,
  status,
  chargingState,
  taskStatus,
  cleaningMode,
  suctionLevel,
  waterFlow,
  waterTank,
  mopPadInstalled,
  errorCode,
  cleaningTime,
  cleanedArea,
  cleanGenius,
  ...rest
} = {}) {
  const operationalStatus = mapOperationalStatus({
    state,
    status,
    chargingState,
    taskStatus,
    cleaningMode,
    waterTank,
    mopPadInstalled,
  });
  const consumables = extractConsumables(rest);
  return {
    battery: clampBattery(battery),
    operationalStatus,
    vacuumcleanerState: mapVacuumcleanerState(operationalStatus),
    onoff: mapOnoff(operationalStatus, { state }),
    suctionLevel: mapSuctionLevel(suctionLevel),
    waterLevel: mapWaterLevel(waterFlow),
    error: isDeviceAlarm(errorCode),
    cleaningTime: clampNonNegative(cleaningTime),
    cleanedArea: clampNonNegative(cleanedArea),
    cleanGenius: mapCleanGenius(cleanGenius),
    ...consumables,
    consumableLow: isConsumableLow(consumables),
  };
}

function parseMiotPropertyList(results) {
  const values = {};
  if (!Array.isArray(results)) {
    return values;
  }
  for (const item of results) {
    if (!item || item.code !== 0) {
      continue;
    }
    values[`${item.siid}-${item.piid}`] = item.value;
  }
  return values;
}

function miotPropertiesToStatus(results) {
  const values = parseMiotPropertyList(results);
  return {
    state: values['2-1'] !== undefined ? values['2-1'] : MovaState.Unknown,
    status: values['4-1'] !== undefined ? values['4-1'] : MovaStatus.Unknown,
    battery: values['3-1'] !== undefined ? values['3-1'] : 0,
    cleaningMode: values['4-23'],
    chargingState: values['3-2'],
    taskStatus: values['4-7'],
    cleaningTime: values['4-2'],
    cleanedArea: values['4-3'],
    suctionLevel: values['4-4'],
    waterFlow: values['4-5'],
    waterTank: values['4-6'],
    selfWashBaseStatus: values['4-25'],
    autoMountMop: values['4-45'],
    mopInStation: values['4-52'],
    mopPadInstalled: values['4-53'],
    cleanGenius: parseAutoSwitchSettings(values['4-50'])[AUTO_SWITCH_CLEAN_GENIUS_KEY],
    errorCode: values['2-2'] !== undefined ? values['2-2'] : 0,
    mainBrush: values['9-2'],
    sideBrush: values['10-2'],
    filter: values['11-1'],
    sensor: values['16-1'],
    mopPad: values['18-1'],
  };
}

module.exports = {
  OPERATIONAL_STATUS,
  clampBattery,
  clampPercent,
  clampNonNegative,
  isMopActive,
  extractConsumables,
  isConsumableLow,
  isDeviceAlarm,
  mapOperationalStatus,
  mapOnoff,
  mapSuctionLevel,
  mapWaterLevel,
  parseAutoSwitchSettings,
  mapCleanGenius,
  mapVacuumcleanerState,
  mapDeviceStatusToHomey,
  parseMiotPropertyList,
  miotPropertiesToStatus,
};
