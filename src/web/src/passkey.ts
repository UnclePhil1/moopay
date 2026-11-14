import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/* The two device prompts the chat page needs. The browser picks what to show: Face ID, Touch ID, Android biometrics,
   Windows Hello, a device PIN, a security key, or a QR code to scan with a phone. */
type Reg = Parameters<typeof startRegistration>[0]["optionsJSON"];
type Auth = Parameters<typeof startAuthentication>[0]["optionsJSON"];

/** A computer with no fingerprint reader or camera cannot sign by itself, so lead with "use your phone" or a security key there. */
async function hints(): Promise<("client-device" | "hybrid" | "security-key")[]> {
  let platform = false;
  try { platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { /* treat as none */ }
  return platform ? ["client-device", "hybrid"] : ["hybrid", "security-key"];
}

(window as unknown as { moopayPasskey: unknown }).moopayPasskey = {
  register: async (optionsJSON: Reg) => startRegistration({ optionsJSON: { ...optionsJSON, hints: await hints() } }),
  assert: async (optionsJSON: Auth) => {
    const hint = await hints();
    // Some phones fail with an "unknown error" when asked for one named key; asking again with no name lets them offer the MooPay passkey they hold.
    return startAuthentication({ optionsJSON: { ...optionsJSON, hints: hint } }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.name === "NotAllowedError" || e.name === "AbortError") throw e;
      const { allowCredentials: _drop, ...open } = optionsJSON as unknown as Record<string, unknown>;
      return startAuthentication({ optionsJSON: { ...(open as unknown as Auth), hints: hint } });
    });
  },
};
