# ReceiptVault — App Store Submission Guide

## App identity

- **Name:** ReceiptVault
- **Price:** $0.99
- **Category:** Finance / Productivity
- **Bundle ID (iOS):** `com.receiptvault.app`
- **Application ID (Android):** `com.receiptvault.app`

---

## 1. iOS App Store (Apple)

### Prerequisites (paid, required)
1. **Apple Developer Program** — $99/year at https://developer.apple.com/programs/
2. Register in App Store Connect: https://appstoreconnect.apple.com

### Build the release app
```bash
cd frontend
npx cap sync ios
cd ios/App
open App.xcodeproj   # opens Xcode
```

In Xcode:
1. Select **ReceiptVault** target → **Signing & Capabilities**
2. Set your **Team** (your Apple Developer account)
3. Change **Bundle Identifier** to `com.receiptvault.app`
4. Add capability: **Background Modes** → check **Location updates**
5. Add a usage description in `Info.plist`:
   - `NSLocationWhenInUseUsageDescription`: "ReceiptVault uses your location to track mileage during work shifts."
   - `NSLocationAlwaysAndWhenInUseUsageDescription`: "ReceiptVault uses your location in the background to track mileage for tax purposes."
6. Set **Product → Archive**

### Upload to App Store Connect
1. **Window → Organizer** → select the archive → **Distribute App**
2. Choose **App Store Connect** → **Upload**

### App Store Connect setup
1. New app → name **ReceiptVault**, bundle ID `com.receiptvault.app`
2. Fill in:
   - **Description:** "Snap a receipt, track your spending, and log business miles. ReceiptVault keeps your expenses organized for tax time."
   - **Keywords:** receipts, expenses, mileage, tax, tracker
   - **Support URL / Privacy Policy:** (required) host on your Render app or GitHub Pages
3. Upload **screenshots** (6.7" iPhone display) — take real screenshots from the simulator
4. Set price **$0.99**
5. Submit for review (Apple review takes 1–3 days)

---

## 2. Google Play (Android)

### Prerequisites (paid, required)
1. **Google Play Console** — $25 one-time at https://play.google.com/console/
2. Android SDK required — this machine doesn't have it. Install **Android Studio** first.

### Build the release APK/AAB
```bash
cd frontend
npx cap add android      # if not already added
npx cap sync android
cd android
# build signed release
./gradlew bundleRelease   # produces .aab
```

Signing: create a keystore (`keytool -genkey -v -keystore receiptvault.keystore`), configure in `android/app/build.gradle`, or use Play App Signing.

### Play Console setup
1. Create app → name **ReceiptVault**, app ID `com.receiptvault.app`
2. **Set up app** → category Finance, price $0.99
3. Upload the `.aab` from **App releases → Production**
4. Fill store listing (same text as iOS)
5. **Data safety form** — declare location data collection
6. Submit for review (usually 1–3 days)

---

## 3. Required backend URL

The native app needs to know which backend to talk to. Set it at **build time**:

```bash
VITE_API_URL=https://tfe-hub.onrender.com npx cap sync ios
# then rebuild in Xcode / Android Studio
```

Or let users set it in-app via **Settings → Backend URL** (already built).

---

## 4. Privacy policy (required by both stores)

Since you collect email + location, both stores require a privacy policy URL. The simplest free option: host a static page on the Render app (add a `/privacy` route) or GitHub Pages. Content must cover:
- What you collect (email, receipt data, location during shifts)
- How it's used
- How to delete data (contact you / delete account)
