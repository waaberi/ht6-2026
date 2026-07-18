const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const ignoredPackageQuarantine = /[/\\]node_modules[/\\]\.ignored(?:[/\\].*)?$/;
const ignoredAndroidBuildOutput = /[/\\]android[/\\](?:\.cxx|build)(?:[/\\].*)?$/;

config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  ignoredPackageQuarantine,
  ignoredAndroidBuildOutput,
];

module.exports = config;
