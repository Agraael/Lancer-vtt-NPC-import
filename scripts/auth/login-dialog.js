import { login, logout, isLoggedIn, getEmail } from "./cognito-auth.js";

export class CompconLoginDialog extends Dialog
{
    constructor(onSuccess)
    {
        const loggedIn = isLoggedIn();
        const currentEmail = getEmail();

        const content = `
            <div class="lancer-dialog-base compcon-login-body">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">COMP/CON SIGN IN</div>
                    <div class="lancer-dialog-subtitle">${loggedIn
        ? `Signed in as <strong>${foundry.utils.escapeHTML?.(currentEmail) ?? currentEmail}</strong>`
        : "Sign in with your Comp/Con account to browse cloud NPCs"}</div>
                </div>

                <div class="lancer-info-box">
                    <i class="fas fa-info-circle"></i>
                    <span>Lancer system v2.12 removed the built-in Comp/Con login. We talk to AWS Cognito directly. Your password is never stored, only a refresh token.</span>
                </div>

                <div class="compcon-login-fields" style="display: grid; gap: 8px; margin-top: 10px;">
                    <label style="display: grid; gap: 4px;">
                        <span>Email</span>
                        <input type="email" id="compcon-email" value="${foundry.utils.escapeHTML?.(currentEmail) ?? currentEmail}" autocomplete="username" required>
                    </label>
                    <label style="display: grid; gap: 4px;">
                        <span>Password</span>
                        <input type="password" id="compcon-password" autocomplete="current-password" required>
                    </label>
                    <div id="compcon-login-error" style="color: #c33; min-height: 1.2em; font-size: 0.9em;"></div>
                </div>
            </div>
        `;

        const buttons = {
            signin: {
                icon: '<i class="fas fa-sign-in-alt"></i>',
                label: loggedIn ? "Re-Sign In" : "Sign In",
                callback: () => {} // listener overrides so dialog stays open on error
            }
        };
        if (loggedIn)
        {
            buttons.signout = {
                icon: '<i class="fas fa-sign-out-alt"></i>',
                label: "Sign Out",
                callback: async () =>
                {
                    await logout();
                    ui.notifications.info("Signed out of Comp/Con");
                    if (typeof onSuccess === "function")
                        onSuccess(false);
                }
            };
        }
        buttons.cancel = {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel"
        };

        super({
            title: "Comp/Con Sign In",
            content,
            buttons,
            default: "signin",
            close: () => {}
        }, {
            width: 420,
            height: "auto",
            classes: ["compcon-login-dialog", "lancer-dialog-base", "lancer-no-title"]
        });

        this._onSuccess = onSuccess;
    }

    activateListeners(html)
    {
        super.activateListeners(html);

        const $err = html.find('#compcon-login-error');
        const $email = html.find('#compcon-email');
        const $password = html.find('#compcon-password');
        const $signin = html.closest('.app').find('button[data-button="signin"]');

        html.find('input').on('keydown', (e) =>
        {
            if (e.key === 'Enter')
            {
                e.preventDefault();
                $signin.trigger('click');
            }
        });

        $signin.off('click').on('click', async () =>
        {
            const email = String($email.val() || '').trim();
            const password = String($password.val() || '');
            if (!email || !password)
            {
                $err.text("Email and password are required.");
                return;
            }
            $err.text("");
            $signin.prop('disabled', true).text("Signing in...");
            try
            {
                await login(email, password);
                ui.notifications.info(`Signed in to Comp/Con as ${email}`);
                this.close();
                if (typeof this._onSuccess === "function")
                    this._onSuccess(true);
            }
            catch (e)
            {
                console.warn("[compcon-login]", e);
                const msg = _humanizeCognitoError(e);
                $err.text(msg);
                $signin.prop('disabled', false).html('<i class="fas fa-sign-in-alt"></i> Sign In');
            }
        });

        setTimeout(() => $password[0]?.focus(), 50);
    }
}

function _humanizeCognitoError(err)
{
    const t = err?.cognitoType || "";
    if (t.includes("NotAuthorizedException"))
        return "Incorrect email or password.";
    if (t.includes("UserNotFoundException"))
        return "No Comp/Con account found for that email.";
    if (t.includes("UserNotConfirmedException"))
        return "Account email not confirmed. Check your inbox.";
    if (t.includes("PasswordResetRequiredException"))
        return "Password reset required. Visit compcon.app to reset.";
    if (t.includes("TooManyRequestsException") || t.includes("LimitExceededException"))
        return "Too many sign-in attempts. Wait a few minutes.";
    return err?.message || "Sign-in failed.";
}
