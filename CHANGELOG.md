# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Kept live terminal output reliably pinned to the bottom across platforms,
  aligned terminal and session-list scrollbar styling, and stabilized tab
  overflow behavior at narrow window widths.
- Returned terminal-generated protocol responses from the canonical session on
  every platform, preventing PowerShell startup and command stalls without
  duplicate renderer replies.
