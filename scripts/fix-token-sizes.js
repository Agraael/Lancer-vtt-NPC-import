/* global game, ui, Dialog, foundry, FormApplication */

// Reconcile each non-manual actor's prototype token size to its Lancer system.size so drops snap right.
// Half-size (0.5) units stay 1x1 (the half-size visual is a Lancer Automations feature).

function _expectedSize(actor)
{
    const size = actor.system?.size;
    if (typeof size !== 'number')
        return null;
    return Math.max(1, Math.round(size));
}

function _needsFix(actor)
{
    const expected = _expectedSize(actor);
    if (expected === null)
        return false;
    const proto = actor.prototypeToken;
    if (!proto || proto.flags?.lancer?.manual_token_size)
        return false;
    return proto.width !== expected || proto.height !== expected;
}

export async function fixTokenSizes()
{
    if (!game.user.isGM)
    {
        ui.notifications.warn("Only a GM can fix token sizes.");
        return;
    }

    const candidates = game.actors.filter(_needsFix);
    if (candidates.length === 0)
    {
        ui.notifications.info("All prototype token sizes already match their Lancer size.");
        return;
    }

    const rows = candidates.slice(0, 30).map(actor =>
    {
        const proto = actor.prototypeToken;
        const size = _expectedSize(actor);
        return `<li><b>${actor.name}</b> <span style="color:var(--la-ink-dim);">${proto.width}x${proto.height} &rarr; ${size}x${size}</span></li>`;
    }).join('');
    const more = candidates.length > 30 ? `<p style="color:var(--la-ink-dim);">&hellip;and ${candidates.length - 30} more.</p>` : '';

    const confirmed = await Dialog.confirm({
        title: "Fix Token Sizes",
        content: `<p>${candidates.length} actor(s) have a prototype token size that doesn't match their Lancer size. Set each to match?</p>
            <p style="color:var(--la-ink-dim);font-size:0.9em;">Manual-size actors are skipped. Half-size units become 1x1. Placed tokens already on scenes are not moved.</p>
            <ul style="max-height:220px;overflow:auto;margin:6px 0;padding-left:18px;">${rows}</ul>${more}`,
        yes: () => true,
        no: () => false,
        defaultYes: true
    });
    if (!confirmed)
        return;

    let fixed = 0;
    for (const actor of candidates)
    {
        const size = _expectedSize(actor);
        try
        {
            await actor.update({ 'prototypeToken.width': size, 'prototypeToken.height': size });
            fixed++;
        }
        catch (e)
        {
            console.warn(`lancer-npc-import | Failed to fix token size for ${actor.name}:`, e);
        }
    }
    ui.notifications.info(`Fixed ${fixed} prototype token size(s).`);
}

export class FixTokenSizesMenu extends FormApplication
{
    static get defaultOptions()
    {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "lancer-npc-import-fix-token-sizes",
            template: "templates/sidebar/dialog.html",
            title: "Fix Token Sizes",
            popOut: false
        });
    }
    render(_force, _options)
    {
        fixTokenSizes();
        return this;
    }
    async close(_options) { return; }
    async _updateObject() {}
}
