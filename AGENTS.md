Telemetry: /tmp/bmx-proto-console.jsonl (errors, slowframe, stuck, crash {why}, trick, record, pref changes). Server log /tmp/bmx-proto-serve.log. Port 7814.
Level features start at local z=0 and extend to -z; tunables are PARAMS in params.js or constants at the top of each module.

Syntax check modules with `for f in *.js; do node --input-type=module --check < $f; done` (plain `node --check` misses ESM errors like duplicate const). After reload, read /tmp/bmx-proto-console.jsonl: `boot-fail` means main.js never ran.
