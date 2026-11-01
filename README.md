# pelican-bmx


https://github.com/user-attachments/assets/08619774-4f4d-4314-9f09-22df0bd66ee2



For years the benchmark was "draw an SVG of a pelican riding a bicycle". The models drew a bird-shaped blob near two circles and everyone clapped. This repo is what happens when you take the benchmark way too literally: the pelican rides a BMX now, does tailwhips, grinds 30 m rails, gets Dragon Ball auras when the special bar fills, and comes apart into six pieces when it leaves the park.

It was written almost entirely by a swarm of LLM agents arguing over who owned `main.js`. The pelican still can't tell you how many r's are in "strawberry", but it can land a flair.

**Play:** https://franciscocarloserra.github.io/pelican-bmx/

## Run locally

    python3 serve.py 7814   # http://localhost:7814/

Any static server works (`serve.py` adds prefs saving and a console log at `/tmp/bmx-proto-console.jsonl`). three.js r170 loads from jsDelivr, so you need internet.

## Controls

WASD or arrows ride, Space hops (hold to charge), Shift sprints, Q/E + direction for flips/grabs, E near an edge grinds, F manuals, R respawns, C recenters the camera. Fill the special bar, then Q+E in the air.

## Caveats

Prototype. Physics are tuned by vibes and a headless sim. Firefox may stutter on crashes. The pelican feels no pain, we checked.

MIT license.
