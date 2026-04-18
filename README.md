# HTTP Toolkit Patcher

A minimal, cross-platform patcher for HTTP Toolkit that removes subscription requirements.

![Screenshot](https://cdn.jsdelivr.net/gh/Thereallo1026/assets@main/assets/Screenshot%202026-04-19%20at%206.29.16%E2%80%AFAM.png)

## Why?

I don't feel like paying a **monthly subscription** for an HTTP proxy/interceptor. A lifetime license? Sure. But subscription-based for a dev tool? No thanks.

## How It Works

The patcher intercepts HTTP Toolkit's authentication functions:
- `isPaidUser`
- `isLoggedIn`
- `userHasSubscription`
- `userEmail`
- `mightBePaidUser`
- `isPastDueUser`

By hooking these functions, we bypass the subscription checks entirely.

## Installation

1. Install Node.js (if not already installed)
2. Install dependencies:
```bash
bun install
```

## Usage

**Patch HTTP Toolkit:**
```bash
bun start
```

**Unpatch/Restore:**
```bash
bun run unpatch
```

**Show help:**
```bash
bun start help
```

That's it. The patcher handles everything automatically and will request elevated permissions if needed.

## Technical Details

1. Finds HTTP Toolkit installation
2. Kills running processes
3. Requests elevation if needed
4. Backs up `app.asar`
5. Extracts and patches `preload.js`
6. Repackages and launches

## Troubleshooting

**Permission errors?** The patcher will automatically request elevated permissions (admin/sudo).

**Already patched?** The patcher will ask if you want to repatch.

**Want to restore?** Run `bun run unpatch` to restore from backup.

**Anything else?** Open an issue on the [GitHub repository](https://github.com/xenos1337/httptoolkit-patcher/issues).

## Disclaimer

This tool is provided as-is. Use at your own risk. For educational purposes only.

## License

MIT License - see [LICENSE](LICENSE) file.

