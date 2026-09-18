#!/usr/bin/env python3
"""Insert the sharpshooter.enabled settings key (part of the #12161 pairing trunk).

Idempotent; called by sync-fork-main.sh after the layer checkout. When can1357
merges #12161 upstream, delete this file and the trunk_apply in sync-fork-main.sh.
"""

p = "packages/coding-agent/src/config/settings-schema.ts"
s = open(p).read()
if '"sharpshooter.enabled"' in s:
    print("sharpshooter.enabled already present")
    raise SystemExit
T = "	"
anchor = f'{T}"sharpshooter.injectionTokenLimit": {{ type: "number", default: 15000 }},'
assert anchor in s, "anchor missing: upstream schema drifted"
block = "\n".join(
    [
        f'{T}"sharpshooter.enabled": {{',
        f'{T*2}type: "boolean",',
        f'{T*2}default: false,',
        f"{T*2}ui: {{",
        f'{T*3}tab: "memory",',
        f'{T*3}group: "Sharpshooter",',
        f'{T*3}label: "Run Sharpshooter Alongside",',
        f'{T*3}description: "Also run Sharpshooter next to the selected memory backend; ignored when it is the backend",',
        f"{T*2}}},",
        f"{T}}},",
    ]
)
s = s.replace(anchor, anchor + "\n" + block, 1)
open(p, "w").write(s)
print("inserted sharpshooter.enabled")
