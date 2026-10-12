module.exports = {
  appId: 'app.lolkamod.installer',
  productName: 'LolkaMod Installer',
  artifactName: 'LolkaModInstaller-${version}-${arch}.${ext}',
  directories: {
    app: '.staging/portable-app',
    output: 'release/portable',
  },
  files: [
    'package.json',
    'main.mjs',
    'preload.cjs',
    'renderer.html',
    'renderer.css',
    'renderer.js',
    'logo.png',
    'app.icon',
    'app.ico',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ],
  extraResources: [
    { from: '.staging/portable-resources/backend.mjs', to: 'backend.mjs' },
    { from: '.staging/portable-resources/dist', to: 'dist' },
    { from: '.staging/portable-resources/portable-manifest.json', to: 'portable-manifest.json' },
  ],
  afterPack: 'scripts/after-pack-portable.cjs',
  publish: null,
  electronLanguages: ['en-US', 'ru'],
  win: {
    icon: 'assets/branding/app.ico',
  },
  mac: {
    icon: 'assets/branding/logo.png',
    minimumSystemVersion: '13.0',
    identity: '-',
    hardenedRuntime: true,
    entitlements: 'DesktopInstaller/entitlements.mac.plist',
    entitlementsInherit: 'DesktopInstaller/entitlements.mac.plist',
  },
  linux: {
    category: 'Utility',
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: 'LolkaMod',
        StartupWMClass: 'LolkaMod',
      },
    },
    icon: 'assets/branding/logo.png',
  },
  deb: {
    packageName: 'lolkamod-installer',
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'pkexec'],
  },
  rpm: {
    packageName: 'lolkamod-installer',
    depends: ['gtk3', 'libnotify', 'nss', 'libXScrnSaver', '(libXtst or libXtst6)', 'xdg-utils', 'at-spi2-core', '(libuuid or libuuid1)', '/usr/bin/pkexec'],
  },
};
