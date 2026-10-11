# SpoolPilot

A small, browser-local companion for 3D printing. Track filament spools, estimate material and electricity costs, and record completed prints. The first interface is in German.

## Run locally

Install Node.js 22 or newer, then run:

```sh
npm run dev
```

Open http://127.0.0.1:43761. No package installation, API key, account or backend is required. To run the tests:

```sh
npm test
```

## How it works

1. Add a spool with its original filament mass, current remaining mass and purchase price. Enter filament mass only, excluding the empty spool.
2. Choose the spool and enter the slicer's estimated filament consumption and print time.
3. Adjust average printer power and electricity price to your own values. The defaults are illustrative assumptions, not measured values.
4. Record a print only once it is completed. Booking subtracts the entered consumption and adds a cost snapshot to the history. Insufficient stock is rejected.

Material cost = spool price × consumed grams / original grams.
Electricity cost = hours × average watts / 1000 × price per kWh.

These estimates exclude maintenance, labour, accessories and failed prints. The app does not read slicer files or connect to a printer. Use actual consumption when available.

## Your data

Spools and print history are stored in this browser's localStorage. They are not sent to a service and do not sync across browsers or devices. Clearing browser storage removes them. Export JSON regularly for backup. Version 0.1 offers export; restoring an exported backup through the interface is planned, not yet implemented. If stored data is corrupt, the app preserves it rather than silently overwriting it.

All assets are local. No analytics, remote fonts or tracking are included. Serve the project over localhost or HTTPS; opening index.html directly is unsupported because the app uses JavaScript modules.

## Development and contributions

The calculation and stock transactions are isolated in core.js. The interface uses native HTML, CSS and JavaScript. Tests use Node's built-in test runner. Run npm test before submitting changes. For bugs, include reproduction steps, browser version and expected/actual results; use fictional spool data in reports.

Current limitations: no editing or deleting spools, no undo, no JSON import and no protection against concurrent updates from multiple tabs. Use one app tab when booking prints.

Planned next steps: backup import with validation; editable stock and reversible bookings; cross-tab consistency; accessibility and browser integration tests.

## Origin

This is a newly written project for schlagskill, prepared with OpenAI coding assistance. It is not a fork or a renamed copy of another repository. Runtime code has no third-party dependencies. The project name is a working name; no claim of trademark exclusivity is made.

## License

MIT — see LICENSE.
