## Installation

1.  On the Foundry VTT setup screen, go to the **Add-on Modules** tab.
2.  Click the **Install Module** button.
3.  At the bottom of the window, paste the following URL into the **Manifest URL** field:
    ```
    https://github.com/Agraael/Lancer-vtt-NPC-import-Macro/releases/latest/download/module.json
    ```
4.  Click **Install**.
5.  Once the installation is complete, launch your world and enable the module in the **Manage Modules** settings.

## Usage

Click the **Import NPCs** button in the Actors sidebar.

### Import from Comp/Con Cloud
1. Login to Comp/Con (Settings → Lancer System Settings → COMP/CON Login)
2. Select "Import from Comp/Con"
3. Choose NPCs and scaling mode
4. Import

### Import from JSON Files
1. Export NPCs from Comp/Con as JSON
2. Select "Import from JSON File(s)"
3. Choose scaling mode and select files

## Id link
NPCs created this way contain their ID from Comp/Con
this allow me to find them for update.
When importing from Comp/Con each NPC will have an indicator whether:
- The NPC does not exist yet
- At least one Actor with similar same exist but is not linked
- the NPC and Actor are synced
- The linked NPC and Actor have different in Stats/Systems etc ...

## Custom Tier Support

For NPCs with custom tiers, choose a scaling mode:
- **Scaled**: Keeps tier increments (0/2/4 if base was 10/12/14)
- **Flat**: Same stats for all tiers (0/0/0)

The module automatically modifies the NPC class and adds "CUSTOM" to the class name.

## Features

- ✅ Import from Comp/Con cloud or JSON files
- ✅ Update existing NPCs
- ✅ Custom tier stat scaling
- ✅ Replace existing Actor and link them
- ✅ Check stats and systems between Comp/Con and VTT Npc

![Import Dialog](Screenshot.png)