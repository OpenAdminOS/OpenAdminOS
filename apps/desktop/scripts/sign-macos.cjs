const { join, resolve } = require("node:path");
const { sign } = require("app-builder-lib/out/codeSign/macCodeSign.js");

module.exports = function signMac(options) {
  const capture = join(options.app, "Contents/Helpers/openadminos-nova-call-capture");
  return sign({
    ...options,
    optionsForFile(file) {
      const defaults = options.optionsForFile(file);
      if (resolve(file) !== resolve(capture)) return defaults;
      // The sibling Electron helpers retain their voice entitlements.
      return { ...defaults, entitlements: join(__dirname, "../build/entitlements.nova-call-capture.plist") };
    },
  });
};
