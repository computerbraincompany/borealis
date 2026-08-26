const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  mac: {
    ...packageJson.build.mac,
    identity: null,
    notarize: false,
  },
};
