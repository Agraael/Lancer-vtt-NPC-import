# Lancer NPC Import

[![Latest module version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import-Macro%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.version&prefix=v&style=for-the-badge&label=module%20version)](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)
![Latest Foundry version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import-Macro%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.compatibility.verified&style=for-the-badge&label=foundry%20version&color=fe6a1f)
<br/>
[![GitHub downloads (total)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import-Macro/module.zip?style=for-the-badge&label=downloads%20(total))](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)
[![GitHub downloads (latest version)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import-Macro/latest/module.zip?style=for-the-badge&label=downloads%20(latest))](https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest)

---

Pulls Lancer content out of Comp/Con and into FoundryVTT. The name says NPC import, but at this point it does a bit more than that.

## What it does

- **NPC import** from Comp/Con cloud or JSON files, with tier scaling and update-in-place.
- **Pilot import patch**: makes the built-in Lancer pilot import also bring in reserves and organizations (the system drops those by default).
- **Pilot share code patch**: the codes that the new Comp/Con hands out work in the pilot sheet again.
- **Pilot cloud sync patch**: the pilot dropdown in the Lancer system pulls from the new Comp/Con.
- **V3 LCP import**: open the Compendium Manager, pick a v3 `.lcp` file, and an **Import v3 LCP** button appears in place of the native one.
- **Refresh items from LCPs**: re-pull compendium item data into existing actors after an LCP update, with a per-item diff preview and per-row opt-in.

The three pilot-side patches run automatically as long as the V3 setting is on (it is, by default).

## Install

Manifest URL:

```
https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest/download/module.json
```

Requires:
- [Lancer system](https://foundryvtt.com/packages/lancer) v2.0.0+
- [Lancer Style Library](https://github.com/Agraael/lancer-style-library)

## Using it

Click **Import NPCs** in the Actors sidebar.

- **From the cloud**: log in under Settings > Lancer System Settings > COMP/CON Login, then pick NPCs and a scaling mode.
- **From JSON**: export from Comp/Con, pick the files, pick a scaling mode. Both v2 and v3 export formats are handled.

For NPCs with custom tiers:
- **Scaled** keeps the tier-to-tier increments (custom base + tier delta).
- **Flat** uses the same custom stats for every tier.

Custom stats are detected by comparing against the class base, so it still works when Comp/Con doesn't flag the tier as "custom".

![Import Dialog](Screenshot.png)

## V3 LCP notes

Button only shows up for v3 LCPs. v2 LCPs go through the normal Lancer importer.

Stuff v3 has that Lancer doesn't:
- Eidolons → each layer becomes an NPC template + features in an `Eidolons` folder. Apply the template you want on the Eidolon actor manually. No layer-swap.
- `active_effects` → lifted into bonuses/actions where possible, rest appended to the item's effect text.
- `add_status` / `add_resist` → appended as text. Lancer doesn't apply statuses from LCPs.


## Refresh items from LCPs

After an LCP update, the compendium gets the new item versions but actors keep the old data. This tool re-pulls compendium items onto existing actors with a per-item diff and opt-in.

Per actor: **Refresh** button in the actor sheet title bar.
Bulk: **Refresh actors** button in the Actors sidebar.


## V3 LCP diff tool

There are way too many LCPs out there for me to test them all, so some translation edge cases probably slipped through. To help with that, I added a diff tool in the module configuration.

Open **Module Settings → Lancer NPC Import → Open LCP Diff Tool**, pick two LCPs, and you get a side-by-side breakdown: per-bucket counts, added/removed/changed entries, and field-level diffs on the items that changed. Nothing is actually imported.

Mainly useful for LCP authors who want to sanity-check that their v3 pack translates the way they expect, but it also gives me something concrete to look at when someone reports a bad import.


## A note on CORS

The V3 Comp/Con API doesn't allow direct browser calls, so the module routes a couple of endpoints (NPC list, share codes) through a CORS proxy. There's a free public one (corsproxy.io) that handles localhost setups, and behind it a small Cloudflare Worker I run that handles everyone else. Most users end up on my Worker because corsproxy.io's free tier is limited to localhost-style origins.

If you ever see a red notification saying the Worker isn't responding, it most likely means the daily limit has been reached. Try again in a few hours.


<details>
<summary>Advanced: endpoint overrides</summary>

If Massif rotates keys or moves hosts, five world settings let you update things without waiting for a module release. World reload required after changing any of them.

- `V3 API Base URL`
- `V3 API Key`
- `V3 CDN Base URL`
- `V2 Share API URL` (comma-separated; covers both the old `api.compcon.app/share` and the `ujgatmvzlg` gateway `old.compcon.app` uses)
- `V2 Share API Key`

</details>


---

<details>
<summary>patreon...</summary>

Well, project became bigger, now there's more people. So the Patreon is starting to get real. If you wanna support my late nights, that's here.

In any case, my stuff would always be free, and if I stop working on it, I'll just close that thing. [Patreon](https://www.patreon.com/cw/LaSossis)

</details>

Check out my other modules and tools: [List of stuff](https://www.patreon.com/posts/list-of-stuff-149377511)
