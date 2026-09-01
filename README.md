


# AquaGuard: Predictive Flood Defense System — Backend & ML Engine

[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?style=flat&logo=nodedotjs)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-Machine_Learning-3776AB?style=flat&logo=python)](https://www.python.org/)
[![Firebase](https://img.shields.io/badge/Firebase-Admin_SDK-FFCA28?style=flat&logo=firebase)](https://firebase.google.com/)
[![ESP32](https://img.shields.io/badge/ESP32-IoT_Hardware-E52B50?style=flat&logo=espressif)](https://www.espressif.com/)

```markdown

## Project Abstract
AquaGuard is an IoT-driven cyber-physical system (CPS) designed for automated flood prediction and defense. This repository contains the **Centralized Node.js Backend and Machine Learning Engine**. It operates as the critical processing layer between the physical ESP32 hardware telemetry and the Next.js presentation dashboard.

## Hardware Prototype & IoT Integration
AquaGuard relies on physical water dynamics to trigger its software pipeline. The hardware acts as the ground-truth data source for the machine learning model.

![AquaGuard Hardware Prototype](WhatsApp%20Image%202026-08-15%20at%206.57.18%20PM_2.jpeg)

**Core Hardware Components:**
* **Microcontroller:** ESP32 handling localized hysteresis filtering and Firebase data pushing.
* **Sensors:** 5x Analog Water Level Sensors at staggered elevations.
* **Actuators:** 2x Servo Motors automating physical flood defense gates.
* **Alert System:** Active Buzzer for hardware-level acoustic warnings.

## Project Pipeline & Directory Structure
The architecture follows a strict three-tier design, uniting the ML models, the event-driven server, and the client dashboard[cite: 1].

```text
aquaguard/
├── ml/
│   ├── data/
│   │   └── real_sensor_data.csv       # Physical rig measurements (d12, d13, d14, d15, severity_label)
│   └── predict_flood.py               # Gaussian Naive Bayes model
├── backend/
│   ├── server.js                      # Firebase-admin listener -> spawns Python -> writes to Firebase
│   ├── package.json
│   └── serviceAccountKey.json         # Firebase Admin SDK key (Ignored by Git)
└── frontend/
    └── (Next.js Dashboard UI)

```

## Machine Learning Workflow (`/ml`)

The predictive capabilities are powered by a **Gaussian Naive Bayes Classifier**, chosen for its computational efficiency and high accuracy in probabilistic classification tasks on time-series sensor data.

* **Training Data:** The model trains directly on the physical container rig's `data/real_sensor_data.csv`.


* **Feature Extraction:** Utilizes only `d12` and `d13` (early-warning sensors) as primary features to maximize prediction speed and minimize latency.


* **Data Augmentation:** Applies Gaussian-jitter augmentation (8x, σ=0.05s) to the ~75 real physical data rows, ensuring model robustness against hardware noise.


* **Synthetic Fallback:** Incorporates a synthetic generator calibrated to physical bounds (`BASE_DELAY_RANGE=(1.0, 4.5)`, `NOISE_STD_SECONDS=0.2`) as a failsafe if the primary CSV is unavailable.



### Calibrated Countdown Mapping

| Class | Range (s) | Midpoint | `show_countdown` Trigger |
| --- | --- | --- | --- |
| **CRITICAL** | 0–10 | ~5s | `true` |
| **WARNING** | 10–25 | ~17s | `true` |
| **MODERATE** | 25–45 | ~35s | `false` |
| **SAFE** | 45–120 | ~80s | `false` |
| *(Source: `SEVERITY_CLASSES` configuration)*<br> |  |  |  |

## System Data Flow Pipeline

The backend utilizes an event-driven architecture to minimize idle processing overhead and ensure instantaneous response times.

```text
ESP32 Sensors → Firebase RTDB (/AquaGuard_Data/Timestamps/WLS3_HitTime)
                    │  (server.js listener, triggered by WLS3)
                    ▼
        Node.js/Express Backend
                    │  Reads WLS1/WLS2 timestamps, computes d12 & d13
                    │  spawn('python', ['ml/predict_flood.py', d12, d13])
                    ▼
     Python: Gaussian Naive Bayes Model
                    │  Returns: {predicted_class, estimated_seconds_remaining, show_countdown}
                    ▼
   Firebase: /AquaGuard_Data/Predictions/Current  <-- Backend writes payload here
                    │  (live onValue subscription triggers Frontend UI)

```

## Local Development & Setup

### 1. Prerequisites

* Node.js (v18.x+)
* Python (3.10+)

### 2. Environment Configuration

Download your Firebase service account key (Firebase Console → Project Settings → Service Accounts → Generate new private key) and save it as `backend/serviceAccountKey.json`.
*Note: This file is ignored by `.gitignore` for security.*

### 3. Installation

```bash
# Install Node.js dependencies
npm install

# Install Machine Learning dependencies
cd ml
pip install scikit-learn pandas joblib numpy

```

### 4. Running the Server

```bash
node server.js

```

The server will initialize on `http://localhost:4000`, establish a persistent connection to the Firebase Realtime Database, and actively listen for `WLS3` hardware triggers to spawn the Python ML script.

## Continuous Integration (CI)

This repository utilizes GitHub Actions to verify backend integrity on every push to the `main` branch. The automated pipeline boots an Ubuntu runner, installs all Node.js and Python dependencies, and executes syntax validation on the core `server.js` file to ensure zero downtime.

