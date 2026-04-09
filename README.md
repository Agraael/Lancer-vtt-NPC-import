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

Enable **Patch to V3 endpoint** in module settings to use the Comp/Con v3 API (dev.compcon.app). This patches:

- NPC cloud import (v3 API + CloudFront CDN)
- Pilot cloud sync (Storage.list/get rerouted to v3)
- Pilot share codes (12-char v3 codes, redirected to v3 /code endpoint)

> Requires reload after toggling.

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
- Update notification on new releases

![Import Dialog](Screenshot.png)
