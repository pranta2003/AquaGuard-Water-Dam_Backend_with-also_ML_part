/**
 * AquaGuard - Node.js (Express + firebase-admin) Backend
 * ==========================================================
 * Trigger: fires ONLY when /AquaGuard_Data/Timestamps/WLS3_HitTime changes
 * (not "all three timestamps present" — strictly the WLS3 write event).
 *
 * On trigger:
 *   1. Read WLS1_HitTime, WLS2_HitTime, and the new WLS3_HitTime
 *      (format: "HH:MM:SS").
 *   2. Calculate elapsed seconds:
 *        d12 = T2 - T1
 *        d13 = T3 - T1
 *   3. Execute the Python Naive Bayes script exactly as specified:
 *        spawn('python', ['ml/predict_flood.py', d12.toString(), d13.toString()])
 *   4. Capture stdout, JSON.parse() the payload
 *      ({predicted_class, estimated_seconds_remaining, show_countdown, range_seconds}).
 *   5. Write it directly to Firebase at /AquaGuard_Data/Predictions/Current,
 *      where the Next.js FloodStatus component subscribes live.
 *
 * Run:
 *   npm install
 *   node server.js
 *
 * Requires:
 *   - serviceAccountKey.json (Firebase Admin SDK credentials) in this folder
 *   - "python" on PATH with scikit-learn/pandas/joblib/numpy installed
 *     (see ../ml/predict_flood.py). On Linux this is often "python3" —
 *     if `python` isn't found, alias it or edit the spawn() call below.
 */

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { spawn } = require("child_process");

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 4000;

const TIMESTAMPS_PATH = "/AquaGuard_Data/Timestamps";
const PREDICTIONS_PATH = "/AquaGuard_Data/Predictions/Current";

// ------------------------------------------------------------
// FIREBASE SETUP
// ------------------------------------------------------------
// 1. Firebase Console -> Project Settings -> Service Accounts ->
//    Generate new private key -> save as "serviceAccountKey.json" here.
// 2. Replace <YOUR-PROJECT-ID> below with your actual Realtime Database URL.
// NEVER commit serviceAccountKey.json to a public repo.
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://aquaguard-iot-5d47e-default-rtdb.firebaseio.com",
});

const db = admin.database();

// ============================================================
// IN-MEMORY MIRROR (optional — for the /api/status debug endpoint only;
// the frontend's primary data path is now a direct Firebase subscription)
// ============================================================
const appState = {
  sensors: {},
  gates: {},
  timestamps: {},
  prediction: {},
  connection: { firebase_connected: false },
};

// ============================================================
// HELPERS
// ============================================================

/**
 * Parses an "HH:MM:SS" string into total seconds since midnight.
 * Assumes same-day sensor hits (no midnight rollover handling).
 */
function timeStringToSeconds(timeStr) {
  const [h, m, s] = timeStr.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * Executes the Python Naive Bayes script via child_process.spawn, exactly
 * as specified: spawn('python', ['ml/predict_flood.py', d12, d13]).
 * Resolves with the parsed JSON prediction object.
 */
function runPythonPrediction(d12, d13) {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn("python", [
      "ml/predict_flood.py",
      d12.toString(),
      d13.toString(),
    ]);

    let stdoutData = "";
    let stderrData = "";

    pythonProcess.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });

    pythonProcess.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Python script exited with code ${code}: ${stderrData}`)
        );
      }
      try {
        resolve(JSON.parse(stdoutData.trim()));
      } catch (err) {
        reject(new Error(`Failed to parse Python stdout as JSON: ${stdoutData}`));
      }
    });

    pythonProcess.on("error", (err) => {
      // Fires if "python" isn't on PATH — on many Linux setups the
      // binary is named "python3" instead; adjust the spawn() call above
      // if you hit this.
      reject(new Error(`Failed to spawn python process: ${err.message}`));
    });
  });
}

/**
 * Writes the parsed prediction JSON directly to Firebase at
 * /AquaGuard_Data/Predictions/Current, tagging it with a server timestamp.
 */
async function writePredictionToFirebase(prediction) {
  await db.ref(PREDICTIONS_PATH).set({
    ...prediction,
    last_updated: admin.database.ServerValue.TIMESTAMP,
  });
}

// ============================================================
// CORE LOGIC: WLS3-triggered prediction pipeline
// ============================================================
async function handleWLS3Update(wls3HitTime) {
  if (!wls3HitTime) {
    console.log("[AquaGuard] WLS3_HitTime cleared or not yet set — skipping.");
    return;
  }

  console.log(`[AquaGuard] WLS3_HitTime updated: ${wls3HitTime}`);

  try {
    const [wls1Snap, wls2Snap] = await Promise.all([
      db.ref(`${TIMESTAMPS_PATH}/WLS1_HitTime`).once("value"),
      db.ref(`${TIMESTAMPS_PATH}/WLS2_HitTime`).once("value"),
    ]);

    const wls1HitTime = wls1Snap.val();
    const wls2HitTime = wls2Snap.val();

    if (!wls1HitTime || !wls2HitTime) {
      console.warn(
        "[AquaGuard] WLS3 fired but WLS1 or WLS2 timestamp is missing — cannot compute deltas yet."
      );
      return;
    }

    const t1 = timeStringToSeconds(wls1HitTime);
    const t2 = timeStringToSeconds(wls2HitTime);
    const t3 = timeStringToSeconds(wls3HitTime);

    const d12 = Math.max(0, t2 - t1);
    const d13 = Math.max(0, t3 - t1);

    console.log(`[AquaGuard] Computed d12=${d12}s, d13=${d13}s. Running prediction...`);

    const prediction = await runPythonPrediction(d12, d13);

    if (prediction.error) {
      console.error("[AquaGuard] Prediction error from Python:", prediction.error);
      return;
    }

    await writePredictionToFirebase(prediction);

    console.log(
      `[AquaGuard] Prediction written to ${PREDICTIONS_PATH}: ` +
        `${prediction.predicted_class} (show_countdown=${prediction.show_countdown}, ` +
        `~${prediction.estimated_seconds_remaining}s)`
    );
  } catch (err) {
    console.error("[AquaGuard] Failed to process WLS3 update:", err.message);
  }
}

// ============================================================
// FIREBASE LISTENERS
// ============================================================
function attachFirebaseListeners() {
  const rootRef = db.ref("/AquaGuard_Data");
  rootRef.once(
    "value",
    () => {
      appState.connection.firebase_connected = true;
      console.log("[AquaGuard] Connected to Firebase Realtime Database.");
    },
    (err) => {
      appState.connection.firebase_connected = false;
      console.error("[AquaGuard] Firebase connection error:", err.message);
    }
  );

  // Mirror sensors/gates/timestamps/predictions into appState purely
  // for the optional /api/status debug endpoint below.
  db.ref("/AquaGuard_Data/Sensors").on("value", (s) => {
    if (s.val()) appState.sensors = s.val();
  });
  db.ref("/AquaGuard_Data/Gates").on("value", (s) => {
    if (s.val()) appState.gates = s.val();
  });
  db.ref("/AquaGuard_Data/Predictions/Current").on("value", (s) => {
    if (s.val()) appState.prediction = s.val();
  });
  db.ref(TIMESTAMPS_PATH).on("value", (s) => {
    if (s.val()) appState.timestamps = s.val();
  });

  // THE core trigger: fires strictly on WLS3_HitTime changes.
  db.ref(`${TIMESTAMPS_PATH}/WLS3_HitTime`).on("value", (snapshot) => {
    handleWLS3Update(snapshot.val());
  });

  console.log(`[AquaGuard] Listening for changes at ${TIMESTAMPS_PATH}/WLS3_HitTime`);
}

// ============================================================
// EXPRESS APP (optional debug endpoints)
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({ ...appState, server_time: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", firebase_connected: appState.connection.firebase_connected });
});

// ============================================================
// START
// ============================================================
attachFirebaseListeners();

app.listen(PORT, () => {
  console.log(`[AquaGuard] Backend server running on http://localhost:${PORT}`);
});
