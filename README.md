# Lancer Comp/Con Sync

[![Latest module version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.version&prefix=v&style=for-the-badge&label=module%20version)](https://github.com/Agraael/Lancer-vtt-NPC-import/releases/latest)
![Latest Foundry version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgithub.com%2FAgraael%2FLancer-vtt-NPC-import%2Freleases%2Flatest%2Fdownload%2Fmodule.json&query=%24.compatibility.verified&style=for-the-badge&label=foundry%20version&color=fe6a1f)
<br/>
[![GitHub downloads (total)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import/module.zip?style=for-the-badge&label=downloads%20(total))](https://github.com/Agraael/Lancer-vtt-NPC-import/releases/latest)
[![GitHub downloads (latest version)](https://img.shields.io/github/downloads/Agraael/Lancer-vtt-NPC-import/latest/module.zip?style=for-the-badge&label=downloads%20(latest))](https://github.com/Agraael/Lancer-vtt-NPC-import/releases/latest)

---

Syncs Lancer pilots, mechs and NPCs between Comp/Con and FoundryVTT, both ways. Used to be Lancer NPC Import, it grew a bit.

## What it does

- **Comp/Con Sync**: import pilots, mechs and NPCs from your Comp/Con cloud, or export your Foundry changes back to Comp/Con. A pilot and each of its mechs can be picked on their own, both ways. Players can use it too.
- **JSON import**: Comp/Con export files, pilots or NPCs, v2 and v3.
- **Pilot import fixes**: the Lancer share-code button works again, and pilot imports keep more Comp/Con data.
- **V3 LCP import**: an **Import v3 LCP** button in the Compendium Manager.
- **v3 data on items**: what Lancer can't store from a v3 LCP stays on the item, shown as chips on the sheet, and you can edit it there.
- **Refresh items from LCPs**: re-pull updated compendium items onto existing actors, with a diff first.
- **LCP Diff Tool**, **Share Code Test** and **Fix Token Sizes** in the module settings.

## Install

Manifest URL:

```
https://github.com/Agraael/Lancer-vtt-NPC-import/releases/latest/download/module.json
```

Requires Foundry v13, the [Lancer system](https://foundryvtt.com/packages/lancer) 2.12.0+ and [Lancer Style Library](https://github.com/Agraael/lancer-style-library) 1.2.0+.

## Using it

Click **Comp/Con Sync** in the Actors sidebar and sign in with your Comp/Con account. Lancer v2.12 dropped the built-in login, so the module talks to AWS Cognito directly. Your password is never stored.

A few things worth knowing:
- Importing a pilot removes talents, skills and core bonuses you added by hand in Foundry, and resets HP, heat, structure, stress and repairs.
- Untick the pilot to import only its mechs. It has to be in Foundry already.
- Remote pilots (added by share code in Comp/Con) don't show up, they live in their owner's account. Use the share code on the pilot sheet.
- Export only works on actors that are already linked (ones you imported). Open Comp/Con and sync after. The Comp/Con file is backed up before each export, in `comp-con-backups/` (or downloaded if you can't upload files).
- NPCs with custom stats: **Scaled** keeps the tier-to-tier increments, **Flat** uses the same stats for every tier.

![Comp/Con Sync](Screenshot.png)

## Players

Players sign in with their own Comp/Con account and only see pilots.
- They can sync the pilots and mechs they own.
- A new pilot or mech needs the **Create Actors** permission.
- Importing mechs without their pilot needs a GM online.

## Pilot import

The Lancer system's own share-code button gets blocked by Comp/Con's CORS rule. With this module installed it works again.

Every pilot import also brings organizations, reserve use, bond burdens, clocks and answers, skill trigger details, and destroyed weapons and systems. Only the active loadout is used.

## V3 LCP import

Open the Compendium Manager, pick a v3 `.lcp`, and an **Import v3 LCP** button shows up in place of the native one. v2 LCPs go through the normal Lancer importer.

With [Lancer Automations](https://github.com/Agraael/lancer-automations) installed, the LCP's downtime actions go to it, for v2 LCPs too.

<details>
<summary>How v3 content is translated</summary>

| v3 feature | Handling |
|---|---|
| `active_effects[]` bonuses / actions / deployables / synergies / counters | Lifted into the item's v2 arrays. Bonuses with their own condition, an accuracy, or an id Lancer Automations applies stay as v3 data instead |
| Action-shaped `active_effects[]` (damage / range / attack / accuracy / condition / frequency) | Synthesized as v2 actions. On NPC features they become text in the effect, not rollable actions |
| `save` (scalar or `.dc`) / `accuracy` / `bonus_damage` scalars | Kept as v3 data |
| `on_attack` / `on_hit` / `on_crit` / `on_miss` as objects | String-coerced; `on_attack` / `on_crit` merged into effect |
| `damage[].val` → `damage[].damage` | Renamed |
| NPC weapon tier arrays | Pass-through (Lancer handles natively) |
| Inline `integrated` items | Flattened to LID strings |
| `core_system.active_effects[]` / `passive_effects[]` | Fanned into `active_bonuses` / `active_actions` / `active_synergies` (+ passive) plus core `deployables` / `counters` |
| `add_status` / `add_resist` / `add_special` / `remove_special` | Kept as v3 data. On deployables they are also written as text |
| `duration` / `condition` / `target` (non-action AEs) | `condition` stays as text in the header, `duration` and `target` are kept as v3 data |
| `bonus_damage` on non-action AEs | Kept as v3 data |
| Structured `save.on_success` / `on_fail` | Text in effect (the save itself is kept as v3 data) |
| Eidolon layers | Each layer → NPC template + features, plus a "<Layer>'s Rules" and a "<Layer>'s Shard" trait, in an `Eidolons` folder. Apply manually, no layer-swap |
| `flavorDescription` / `brew` / `deprecated` | Dropped |

</details>

## v3 data on items

It shows as chips on the item sheet, in the box it belongs to. Actor sheets and chat cards show them too.

If you can edit the item, the item sheet gives each chip edit and delete buttons, and a **+** to add your own.

On its own it's only display. With [Lancer Automations](https://github.com/Agraael/lancer-automations) installed, it gets applied: resistances, accuracy, bonus damage, use limits, durations, extra actions.

Actors you already imported pick up changes with **Refresh**.

## Refresh items from LCPs

**Refresh** in the actor sheet title bar, or **Refresh actors** in the Actors sidebar (GM) for whole folders or compendiums. Give it an LCP file to only refresh that file's items. Shows a per-item diff, you pick what to apply.

## Tools

In the module settings, GM only:
- **LCP Diff Tool**: there are way too many LCPs out there for me to test them all, so some translation edge cases probably slipped through. It compares what two LCPs would import, without importing anything. Mainly for LCP authors, and it gives me something concrete to look at when someone reports a bad import.
- **Share Code Test**: tries a share code through each proxy and shows the raw response.
- **Fix Token Sizes**: sets prototype tokens to the actor's Lancer size. Manual sizes are skipped, half-size becomes 1x1, placed tokens aren't touched.

## A note on CORS

The Comp/Con API doesn't allow direct browser calls, so the module goes through a CORS proxy: corsproxy.io first, then my Cloudflare Worker. Exports only use the Worker.

If a red notification says the Worker isn't responding, it's hit its daily limit. Try again in a few hours.

<details>
<summary>Advanced: endpoint overrides</summary>

If Massif rotates keys or moves hosts, you can update these endpoints in the settings without waiting for a module release. Reload the world after changing any of them.

- `V3 API Base URL`
- `V3 API Key`
- `V3 CDN Base URL`

</details>

---

<details>
<summary>patreon...</summary>

Well, project became bigger, now there's more people. So the Patreon is starting to get real. If you wanna support my late nights, that's here.

In any case, my stuff would always be free, and if I stop working on it, I'll just close that thing. [Patreon](https://www.patreon.com/cw/LaSossis)

</details>

Check out my other modules and tools: [List of stuff](https://www.patreon.com/posts/list-of-stuff-149377511)
