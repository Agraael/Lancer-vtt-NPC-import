# Lancer NPC Import

[![Latest module version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import-Macro%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.version&prefix=v&style=for-the-badge&label=module%20version)](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)
![Latest Foundry version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import-Macro%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.compatibility.verified&style=for-the-badge&label=foundry%20version&color=fe6a1f)
<br/>
[![GitHub downloads (total)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import-Macro/module.zip?style=for-the-badge&label=downloads%20(total))](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)
[![GitHub downloads (latest version)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import-Macro/latest/module.zip?style=for-the-badge&label=downloads%20(latest))](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)

---

Import Lancer NPCs into FoundryVTT from Comp/Con cloud (v2 and v3) or JSON files.

## Installation

**Manifest URL:**
```
https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest/download/module.json
```

### Required
- [Lancer system](https://foundryvtt.com/packages/lancer) v2.0.0+
- [Lancer Style Library](https://github.com/Agraael/lancer-style-library)

## Usage

Click the **Import NPCs** button in the Actors sidebar.

### Import from Comp/Con Cloud
1. Login to Comp/Con (Settings > Lancer System Settings > COMP/CON Login)
2. Select "Import from Comp/Con"
3. Choose NPCs and scaling mode
4. Import

### Import from JSON Files
1. Export NPCs from Comp/Con as JSON
2. Select "Import from JSON File(s)"
3. Choose scaling mode and select files

## Comp/Con V3 Support

As of 2026-04-22, `compcon.app` is V3 and the legacy `api.compcon.app/share` endpoint is offline. V2 lives at `old.compcon.app`. The **Patch to V3 endpoint** setting is now **on by default** because pilot and NPC import will not work against the current Lancer system without it.

What the patch does:

- NPC cloud import: fetches the NPC roster from the V3 API.
- NPC JSON file import: handles v2 and v3 export formats.
- Lancer pilot cloud sync: pilot dropdown pulls from V3.
- Lancer pilot share codes: v3 12-char codes work in the pilot sheet.

Disable only if you are hosting a private V2 deployment that still works.

### Endpoint Overrides

Five world-scope settings expose the V3/V2 hosts so you can update them without a module release if Massif Press rotates keys or moves hosts:

- `V3 API Base URL` (default: `https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod`)
- `V3 API Key` (default matches production `compcon.app`)
- `V3 CDN Base URL` (default: `https://ds69h3g1zxwgy.cloudfront.net`)
- `V2 Share API URL` (comma-separated; intercepts both `api.compcon.app/share` and the `ujgatmvzlg` gateway that `old.compcon.app` uses)
- `V2 Share API Key`

All five require a world reload to take effect.


## Custom Tier Support

For NPCs with custom tiers, choose a scaling mode:
- **Scaled**: Keeps tier increments (custom value + tier difference from base)
- **Flat**: Same custom stats for all tiers

The module detects custom stats automatically by comparing against the class base stats, even when the tier field is not explicitly "custom" (v3 behavior).

## Features

- Import from Comp/Con cloud (v2 + v3) or JSON files
- Update existing NPCs (by LID matching)
- Manual replace mode (choose target actor)
- Custom tier stat scaling (flat or scaled)
- Auto-detect custom stats vs class base
- Portrait download to server
- Sync status indicators (new, synced, modified, unlinked)
- Link unlinked actors by name
- Pilot JSON import: reserves and organizations
- Update notification on new releases

![Import Dialog](Screenshot.png)
