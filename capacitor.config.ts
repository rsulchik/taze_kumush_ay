import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kumushay.inventory",
  appName: "Kumush_ay",
  webDir: "mobile/www",
  // Keep the existing web origin so previously cached IndexedDB data and
  // queued offline edits remain available after updating the APK.
  server: {
    hostname: "kumushay.resulsopyyev71.workers.dev",
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
