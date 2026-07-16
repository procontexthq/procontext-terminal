# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Integrated terminal tabs and essential controls into a streamlined native
  title bar that respects Windows, macOS, and Linux window-control safe areas.
- Added local scrollback search and validated clickable HTTP(S) and local-path
  links, with native targets rechecked before they are opened or revealed.
- Added focused terminal settings for appearance, shell profiles, scrollback,
  accessibility, recording, and human-terminal presentation defaults.
- Restored the primary window's saved display position and size while keeping
  invalid or off-screen geometry from making the application inaccessible.
- Added credentialed production release validation for native installers,
  signing and notarization, packaged PTY behavior, and artifact provenance.

### Fixed

- Kept the surviving terminal focused after tab closure and allowed the final
  sidebar-managed view to hide or terminate without spawning a replacement PTY.
- Removed duplicate and contrasting Windows terminal scrollbar artifacts and
  aligned the custom scrollbar with the terminal workspace edge.
- Kept live terminal output reliably pinned to the bottom across platforms,
  aligned terminal and session-list scrollbar styling, and stabilized tab
  overflow behavior at narrow window widths.
- Returned terminal-generated protocol responses from the canonical session on
  every platform, preventing PowerShell startup and command stalls without
  duplicate renderer replies.
