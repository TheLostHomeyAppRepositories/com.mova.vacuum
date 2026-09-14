'use strict';

const { createCloudVacuumDriver } = require('../../lib/homey/vacuum-driver');

module.exports = createCloudVacuumDriver({
  family: 'dreame',
  label: 'MOVA Vacuum (Dreame model)',
});
