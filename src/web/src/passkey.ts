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
  assert: async (optionsJSON: Auth) => startAuthentication({ optionsJSON: { ...optionsJSON, hints: await hints() } }),
};
