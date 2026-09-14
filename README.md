# MOVA Vacuum for Homey

Control a MOVA robot vacuum from Homey with your MOVAhome account.

## Pairing

Homey logs in with **email and password only**. A website login code from mova.tech will not work.

1. In the official **MOVAhome** app, set a password for your account (Forgot password / Set password). Do this even if you originally signed up with Apple ID.
2. In Homey, add a device → **MOVA Vacuum** (V50 / V70 / P50 / S70 and other `mova.vacuum` models) or **MOVA Vacuum (Dreame model)** (M1, G20, E10, E20 and other `dreame.vacuum` models)
3. Choose your MOVAhome cloud region
4. Enter that email and password
5. Select the vacuum from the account’s device list

The Dreame-model driver has start, pause, stop, dock, locate, suction, water, status and consumables. It does not include auto-empty, mop wash or CleanGenius.

## What you can do

Start, pause, stop, dock, locate, set suction and water, use CleanGenius, empty the dustbin, wash the mop, and follow battery, status and consumables. Homey Pro 12.3+ also has a live floor-map dashboard widget.

This is a community app and is not affiliated with MOVA or Dreame.
