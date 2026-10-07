/* Meds push settings shared by the app (index.html loads this) and the reminder
 * sender (scripts/send-push.mjs reads it). Only public values belong here.
 *
 * vapidPublicKey: the public half of the push key pair. The private half lives only in
 *   the repo secret VAPID_PRIVATE_KEY. If you ever make a new pair, update both, then
 *   re-enable push on every device and update the PUSH_SUBSCRIPTION secret.
 * pushSubject: who is sending. Apple requires a mailto: or https: address.
 */
var MedsConfig = {
  vapidPublicKey: 'BEwwKoecBsjdb5f9QAPzEO2--v-OE7ckMDVbmEzi8YcI-TdFfHv9HJyBnwbFAwfdopFT7ctt5W-LwoLByL3DmM4',
  pushSubject: 'https://srichards391.github.io/medication-tracker/',
};
if (typeof module === 'object' && module.exports) module.exports = MedsConfig;
