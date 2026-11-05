# Build code dictionaries

Share codes use format `3.` and the frozen dictionary in
`frontend/data/build-code-catalog-v1.js`. Store the dictionary in the repository
and ship it with both the website and desktop app. Codes need no per-build
server record or network lookup.

Keep every published dictionary file and its script tag permanently. Never
regenerate an existing version, reorder its entries, or edit its contents.
Changes to the live item database must not change the meaning of shared codes.

`scripts/release_prep.py` checks the newest dictionary against
`backend/tarkov.db` first and prints a warning when buildable items or slots are
missing, when the encoder does not use the newest version, or when a script tag
is missing. When it warns, generate a new dictionary from the local database:

```powershell
python scripts/build_code_catalog.py --version 2
```

Add the new file's script tag before `build-manager.js`, retaining all earlier
dictionary tags. Update the encoder's `version` in
`_encodeDictionaryBuildCode` to use the new dictionary. Use one canonical file
per version across every deployment. The generator refuses to overwrite files.
The numbered filenames are permanent and do not need release cache hashes.

The dictionary format uses an 8-bit catalog version, 2-bit ammo flags, 8-bit
attachment count, and the gun's item index. For each attachment, encode its
parent's position among the gun and prior attachments, its slot's position in
the frozen parent slot list, and its position in the frozen allowed-item list.
Use the minimum bits needed for each list. Reserve the last allowed-item choice
as an escape to a global item index, preserving items outside the frozen allowed
list. Append selected ammo item indices, zero padding to a byte boundary, and
a big-endian CRC-16/CCITT-FALSE checksum. Use unpadded base64url after `3.`.

When an item or slot is absent from the dictionary, or pairs cannot be encoded
in their original order, export the complete build in `2.` format instead.
Keep the legacy LZString and `2.` readers and writers available for conversion.
Do not replace missing attachments with a default or omit them.

The supplied 11-attachment example has a 298-character v2 code and a
29-character v3 code. Its independently generated Python fixture is in
`frontend/tests/data/build-code-golden.json`. Run frontend regression tests only
when permitted by the repository working agreement.
