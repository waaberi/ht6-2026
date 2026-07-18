const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = (config) => withAndroidManifest(config, (androidConfig) => {
  const application = androidConfig.modResults.manifest.application?.[0];
  if (application) application.$['android:usesCleartextTraffic'] = 'true';
  return androidConfig;
});

