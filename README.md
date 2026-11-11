# Stone Pit

Stone Pit is a React + Vite web client backed by an Express API, Firebase Authentication, and Cloud Firestore. Shared, tested game rules live in `packages/game`.

## Requirements

- Node.js 20+
- A Firebase project with Email/Password Authentication and Cloud Firestore enabled

## Firebase setup

1. In Firebase Console → **Authentication → Sign-in method**, enable the providers you want to offer: **Email/Password**, **Phone**, **Google**, and **Apple**. Add your local and production hostnames under **Authorized domains** for popup sign-in.
2. Create a **Cloud Firestore** database. The API accesses it using the Firebase Admin SDK.
3. Add a Firebase **Web app** to the project. Copy its API key, auth domain, project ID, storage bucket, messaging sender ID, and app ID into `apps/web/.env.local`:

   ```dotenv
   VITE_FIREBASE_API_KEY=your-web-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=your-messaging-sender-id
   VITE_FIREBASE_APP_ID=your-web-app-id
   VITE_FIREBASE_MEASUREMENT_ID=your-measurement-id
   VITE_API_URL=http://localhost:3001
   ```

4. Configure server credentials in the root `.env` (copy `.env.example`). For local development, create a Firebase service-account key and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path, or set `FIREBASE_SERVICE_ACCOUNT` to the service-account JSON. Keep this credential private and out of source control.
5. In Firebase Console → Firestore → Rules, use the rules in [`firestore.rules`](./firestore.rules). The API uses the Admin SDK; browser clients do not access Firestore directly.
6. Install dependencies with `npm install`, start the app with `npm run dev`, and open `http://localhost:5173`.

The sign-in screen supports email/password, Google, Apple, and phone verification by SMS. For phone sign-in, Firebase uses a reCAPTCHA challenge and may require billing or an SMS quota; configure test phone numbers in Firebase Authentication during development. Apple sign-in also requires the Apple provider credentials and redirect settings from your Apple Developer account. Configure password reset email templates under Firebase Authentication → Templates; players can use **Forgot password?** under the email/password form to receive a secure reset link. If the email does not arrive, check spam and confirm the address and email templates in Firebase.

Game Center is only available to native Apple-platform apps; Firebase's web Authentication SDK does not support Game Center sign-in for this browser game.

Players can choose **Play as Guest** to start immediately in local Pass & Play or local AI mode. Guest games are not saved to an account; online multiplayer, leaderboard, profile, and the coin shop require creating or signing into an account.

Firebase Auth issues ID tokens in the browser; the API verifies them with the Admin SDK. Player profiles are stored in `users/{uid}`, game state in `games/{gameId}`, and payment records in `payments/{paymentId}`. No SQL migration is required.

For emulator-based development, run the Firebase Auth and Firestore emulators and set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, `VITE_FIREBASE_AUTH_EMULATOR_URL=http://127.0.0.1:9099`, and the matching Firebase project ID.

## Backend API

- `GET /api/health`
- `POST /api/me/sync`, `GET /api/me`, `PATCH /api/me`
- `GET /api/leaderboard`
- `POST /api/games`, `POST /api/games/:id/moves` for server-validated AI games
- Socket.IO events `room:create`, `room:join`, `game:move`, and `game:state` for online play
- `POST /api/payments`, `GET /api/payments/:id` for optional IntaSend M-Pesa coin purchases

Protected HTTP routes use `Authorization: Bearer <Firebase ID token>`. Passwords are handled by Firebase Authentication and are never stored by this API. IntaSend payments remain unavailable until `INTASEND_SECRET_KEY` is configured; do not put that secret in frontend code.

## Checks

- `npm test` runs game-rule and API package tests.
- `npm run build` builds the web client.
- `npm run check` runs both.
