# EFTForge

EFTForge is a modern Escape from Tarkov build simulator and EvoErgo engine.

It provides a real-time weapon modding system with attachment tree simulation, factory preset modeling, ammo weight integration, and live conflict detection. Powered by tarkov.dev API.


## Features

- Full recursive attachment tree system
- Factory preset auto-install simulation
- EvoErgo calculation engine
- Ammo weight modeling (full magazine assumption)
- Real attachment conflict detection (conflictingItems + conflictingSlotIds)
- Conflict highlighting with non-blocking toast notifications
- Clean and responsive UI


## EvoErgo Concept Credit

The EvoErgo concept was originally developed by **SpaceMonkey37**.

EFTForge implements and expands upon this idea in a live simulation environment.  
This project would not have been possible without the foundational work and theory developed by SpaceMonkey37.


## Tech Stack

Backend:
- FastAPI
- SQLAlchemy
- SQLite
- tarkov.dev GraphQL integration

Frontend:
- Vanilla JavaScript
- Dynamic attachment tree rendering
- Real-time stat calculation
- Custom toast notification system


## Project Status

Active development.

This project is currently focused on building a stable and accurate modding simulation engine.  
Future improvements may include advanced stat modeling, auto-conflict resolution, and performance optimizations.


## Disclaimer

EFTForge is a fan-made project and is not affiliated with Battlestate Games.  
All Escape from Tarkov data is sourced from https://tarkov.dev.
