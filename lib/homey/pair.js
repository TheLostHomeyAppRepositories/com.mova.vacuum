'use strict';

const { MovaCloudClient } = require('../mova/client');
const { toHomeyStoreDevice } = require('../mova/devices');
const { normalizeRegion } = require('../mova/constants');

function createCloudClient(logger, credentials) {
  return new MovaCloudClient({
    username: credentials.username,
    password: credentials.password,
    region: normalizeRegion(credentials.region),
    logger,
  });
}

async function loginAndList(logger, credentials, family) {
  const client = createCloudClient(logger, credentials);
  await client.login(credentials.username, credentials.password, credentials.region);
  const vacuums = await client.listDevices({ family });
  return { client, vacuums };
}

function familyLabel(family) {
  return family === 'dreame' ? 'dreame' : 'MOVAhome';
}

function attachPairSession(driver, session, family = 'mova') {
  let credentials = null;
  let listV2Client = null;

  session.setHandler('login', async (data) => {
    const username = (data.username || '').trim();
    const password = data.password || '';
    const region = normalizeRegion(data.region);
    if (!username || !password) {
      throw new Error(driver.homey.__('error.login_missing'));
    }

    credentials = { username, password, region };
    const { client, vacuums } = await loginAndList(driver, credentials, family);
    listV2Client = client;
    driver.log(`Pairing login ok (${region}), vacuums=${vacuums.length}`);
    return true;
  });

  session.setHandler('list_devices', async () => {
    if (!credentials) {
      throw new Error(driver.homey.__('error.not_logged_in'));
    }
    const client = listV2Client || createCloudClient(driver, credentials);
    if (!listV2Client) {
      await client.login(credentials.username, credentials.password, credentials.region);
    }
    const vacuums = await client.listDevices({ family });
    const devices = vacuums.map((device) => toHomeyStoreDevice(device, {
      ...credentials,
      session: client.getSession(),
    }));
    driver.log(`Pairable ${familyLabel(family)} vacuums: ${devices.map((d) => d.store.model).join(', ') || '(none)'}`);
    return devices;
  });
}

function attachRepairSession(driver, session, device) {
  session.setHandler('login', async (data) => {
    const username = (data.username || '').trim();
    const password = data.password || '';
    const region = normalizeRegion(data.region || device.getStoreValue('region'));
    if (!username || !password) {
      throw new Error(driver.homey.__('error.login_missing'));
    }

    const client = createCloudClient(driver, { username, password, region });
    await client.login(username, password, region);
    const sessionInfo = client.getSession();

    await device.setStoreValue('username', username);
    await device.setStoreValue('password', password);
    await device.setStoreValue('region', region);
    if (sessionInfo) {
      await device.setStoreValue('accessToken', sessionInfo.accessToken);
      await device.setStoreValue('refreshToken', sessionInfo.refreshToken);
      await device.setStoreValue('expiresAt', sessionInfo.expiresAt);
      await device.setStoreValue('uid', sessionInfo.uid);
    }

    if (typeof device.applyCredentials === 'function') {
      await device.applyCredentials({ username, password, region, session: sessionInfo });
    }
    await device.setAvailable();
    driver.log(`Repair login ok for ${device.getName()}`);
    return true;
  });
}

module.exports = {
  createCloudClient,
  loginAndList,
  attachPairSession,
  attachRepairSession,
};
