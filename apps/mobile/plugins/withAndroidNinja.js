const { withAppBuildGradle } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const generatedSection = `        // pnpm android supplies a modern Ninja because Android's CMake 3.22 package bundles Ninja 1.10.
        if (System.getenv('EXPOSURE_NINJA')) {
            externalNativeBuild {
                cmake {
                    arguments "-DCMAKE_MAKE_PROGRAM=\${System.getenv('EXPOSURE_NINJA')}"
                }
            }
        }`;

module.exports = (config) => withAppBuildGradle(config, (androidConfig) => {
  if (androidConfig.modResults.language !== 'groovy') {
    throw new Error('The Android Ninja plugin requires a Groovy app/build.gradle.');
  }

  androidConfig.modResults.contents = mergeContents({
    tag: 'exposure-windows-ninja',
    src: androidConfig.modResults.contents,
    newSrc: generatedSection,
    anchor: /^\s*defaultConfig\s*\{\s*$/m,
    offset: 1,
    comment: '//',
  }).contents;

  return androidConfig;
});
