/* ==========================================================================
   HELIOS — Solar Health & Circadian Tracker
   Core Application & Scientific Engines
   ========================================================================== */

// --- Constants & Calibration Factors ---
const VIT_D_DAILY_GOAL = 2000; // IU
const NIR_DAILY_GOAL = 150000; // mJ/cm² (Target deep system boost)

// Fitzpatrick Skin Type Factors (Multiplier for required UV dose relative to Type I)
const FITZPATRICK_FACTORS = {
    "1": 1.0,  // Type I: Extremely fair
    "2": 1.3,  // Type II: Fair
    "3": 1.8,  // Type III: Medium
    "4": 2.5,  // Type IV: Olive
    "5": 4.0,  // Type V: Brown
    "6": 5.5   // Type VI: Dark Black
};

// Clothing Absorption and Skin Area Coverage Coefficients
const CLOTHING_COEFFICIENTS = {
    "jacket": {
        exposedArea: 0.15,      // Heavy Jacket & Jeans
        nirTransmission: 0.70    // 70% of NIR passes through clothing (30% reduction as in paper)
    },
    "sleeves": {
        exposedArea: 0.30,      // Long Sleeves & Trousers
        nirTransmission: 0.70
    },
    "tshirt_trousers": {
        exposedArea: 0.35,      // T-Shirt & Trousers (Exposes arms, neck, face)
        nirTransmission: 0.70
    },
    "long_dress": {
        exposedArea: 0.40,      // Long Dress with Short Sleeves (Exposes arms, neck, calves)
        nirTransmission: 0.70
    },
    "short_dress": {
        exposedArea: 0.50,      // Short Dress with Short Sleeves (Exposes arms, lower legs, neck)
        nirTransmission: 0.70
    },
    "tshirt": {
        exposedArea: 0.55,      // T-Shirt & Shorts
        nirTransmission: 0.70
    },
    "swim": {
        exposedArea: 0.85,      // Swimsuit / Minimal coverage
        nirTransmission: 0.70
    }
};

// Fallback Location: Leicester, UK
const FALLBACK_LOCATION = {
    latitude: 52.6369,
    longitude: -1.1398,
    name: "Leicester, UK"
};

// Local Date Formatter (YYYY-MM-DD) avoiding timezone shifts
function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- App State ---
let appState = {
    coordinates: null,
    locationName: "Locating...",
    hourlyForecast: null,
    currentWeather: {
        uvIndex: 0,
        shortwaveRadiation: 0, // GHI in W/m²
        nirPower: 0,          // estimated NIR in W/m²
        solarAltitude: 0      // sun elevation in degrees
    },
    session: {
        isActive: false,
        timerId: null,
        durationSeconds: 0,
        accumulatedVitD: 0,
        accumulatedNirDose: 0, // mJ/cm²
        skinType: "2",
        clothingLevel: "tshirt_trousers"
    },
    history: []
};

// --- Initialisation ---
document.addEventListener("DOMContentLoaded", () => {
    initClock();
    initNavigation();
    initHistory();
    requestLocation();
    setupTrackerEventListeners();
    setupPwaPrompt();
    registerServiceWorker();
    setupAutoRefresh();
});

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("sw.js")
                .then(reg => console.log("Service Worker registered successfully:", reg.scope))
                .catch(err => console.error("Service Worker registration failed:", err));
        });
    }
}

function setupAutoRefresh() {
    // 1. Sync GPS & solar weather instantly when PWA resumes from background suspension
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            console.log("Helios resumed from background. Syncing GPS and solar weather...");
            requestLocation();
        }
    });

    // 2. Auto-refresh weather metrics every 30 minutes if left active on screen
    setInterval(() => {
        console.log("Helios periodic refresh: Syncing GPS and solar weather...");
        requestLocation();
    }, 30 * 60 * 1000);
}

// --- 1. Circadian Clock Manager ---
function initClock() {
    const timeEl = document.getElementById("currentTime");
    
    function updateClock() {
        const now = new Date();
        timeEl.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        // Recalculate sun position and current window status every minute
        if (now.getSeconds() === 0 && appState.hourlyForecast) {
            updateSolarMetricsAndArc();
        }
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// --- 2. Tab Navigation Controller ---
function initNavigation() {
    const tabs = {
        navHomeBtn: document.querySelector(".solar-arc-container"),
        navSessionBtn: document.querySelector(".session-tracker-container"),
        navInsightsBtn: document.querySelector(".science-insights-container")
    };
    
    Object.keys(tabs).forEach(btnId => {
        const btn = document.getElementById(btnId);
        btn.addEventListener("click", () => {
            // Remove active classes
            document.querySelectorAll(".nav-tab").forEach(tab => tab.classList.remove("active-tab"));
            
            // Set active class
            btn.classList.add("active-tab");
            
            // Smooth scroll to targeted card
            if (tabs[btnId]) {
                tabs[btnId].scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    });
}

// --- 3. Geolocation & Open-Meteo Integration ---
function requestLocation() {
    const locationText = document.getElementById("locationText");
    
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                appState.coordinates = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                };
                appState.locationName = "GPS Active";
                locationText.innerText = "GPS Connected";
                fetchSolarData();
            },
            (error) => {
                console.warn("Geolocation declined or unavailable. Using Leicester, UK as default.", error);
                appState.coordinates = {
                    latitude: FALLBACK_LOCATION.latitude,
                    longitude: FALLBACK_LOCATION.longitude
                };
                appState.locationName = FALLBACK_LOCATION.name;
                locationText.innerText = FALLBACK_LOCATION.name;
                fetchSolarData();
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    } else {
        appState.coordinates = {
            latitude: FALLBACK_LOCATION.latitude,
            longitude: FALLBACK_LOCATION.longitude
        };
        appState.locationName = FALLBACK_LOCATION.name;
        locationText.innerText = FALLBACK_LOCATION.name;
        fetchSolarData();
    }
}

async function fetchSolarData() {
    if (!appState.coordinates) return;
    
    const lat = appState.coordinates.latitude.toFixed(4);
    const lon = appState.coordinates.longitude.toFixed(4);
    
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=uv_index,shortwave_radiation&timezone=auto`);
        if (!response.ok) throw new Error("API network failure");
        
        const data = await response.json();
        appState.hourlyForecast = data;
        
        updateSolarMetricsAndArc();
        renderHistoryChart();
    } catch (err) {
        console.error("Error fetching data from Open-Meteo:", err);
        document.getElementById("locationText").innerText = "Data Offline";
    }
}

// --- 4. Solar Maths & Dashboard Visualizer ---
function updateSolarMetricsAndArc() {
    if (!appState.hourlyForecast || !appState.hourlyForecast.hourly) return;
    
    const now = new Date();
    const currentHour = now.getHours();
    
    const times = appState.hourlyForecast.hourly.time;
    const uvArray = appState.hourlyForecast.hourly.uv_index;
    const ghiArray = appState.hourlyForecast.hourly.shortwave_radiation;
    
    // Find index matching the current local date and hour (e.g. YYYY-MM-DDTHH:00)
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hourStr = String(now.getHours()).padStart(2, '0');
    const targetTimeStr = `${year}-${month}-${day}T${hourStr}:00`;
    
    let activeIndex = times.indexOf(targetTimeStr);
    if (activeIndex === -1) {
        // Fallback to absolute index for the active hour of the first day
        activeIndex = currentHour;
    }
    
    // Set active stats
    const currentUv = uvArray[activeIndex] !== undefined ? uvArray[activeIndex] : 0;
    const currentGhi = ghiArray[activeIndex] !== undefined ? ghiArray[activeIndex] : 0;
    
    appState.currentWeather.uvIndex = currentUv;
    appState.currentWeather.shortwaveRadiation = currentGhi;
    // Scientific Assumption: ~52% of shortwave solar irradiance reaching the ground is NIR (700-1000nm)
    appState.currentWeather.nirPower = currentGhi * 0.52; 
    
    // Update Dashboard Gauge Values
    document.getElementById("uvValue").innerText = currentUv.toFixed(1);
    document.getElementById("nirValue").innerHTML = `${Math.round(appState.currentWeather.nirPower)} <span class="unit">W/m²</span>`;
    
    // Compute progress bar percentages (Scale UV index from 0 to 11, NIR from 0 to 600 W/m²)
    const uvPercent = Math.min((currentUv / 11) * 100, 100);
    const nirPercent = Math.min((appState.currentWeather.nirPower / 600) * 100, 100);
    
    document.getElementById("uvBar").style.width = `${uvPercent}%`;
    document.getElementById("nirBar").style.width = `${nirPercent}%`;
    
    // Set dynamic descriptions and colors
    updateLabelsAndBadges(currentUv, appState.currentWeather.nirPower);
    
    // Draw the solar zenith arc position
    drawSolarArc(now);
    
    // Adapt the full page background glow based on the solar state
    updateDynamicAtmosphere(now);
}

function updateLabelsAndBadges(uv, nir) {
    const uvLabel = document.getElementById("uvLabel");
    const nirLabel = document.getElementById("nirLabel");
    
    // Reset classes
    uvLabel.className = "gauge-label";
    nirLabel.className = "gauge-label";
    
    // UV Classification
    if (uv === 0) {
        uvLabel.innerText = "None";
    } else if (uv <= 2.9) {
        uvLabel.innerText = "Low";
        uvLabel.classList.add("active-uv-low");
    } else if (uv <= 5.9) {
        uvLabel.innerText = "Moderate";
        uvLabel.classList.add("active-uv-mod");
    } else {
        uvLabel.innerText = "High";
        uvLabel.classList.add("active-uv-high");
    }
    
    // NIR Classification
    if (nir <= 10) {
        nirLabel.innerText = "Inactive";
    } else if (nir <= 150) {
        nirLabel.innerText = "Rejuvenating";
        nirLabel.classList.add("active-nir");
    } else if (nir <= 300) {
        nirLabel.innerText = "Deep Tissue Boost";
        nirLabel.classList.add("active-nir");
    } else {
        nirLabel.innerText = "Max Stimulation";
        nirLabel.classList.add("active-nir");
    }
    
    // Determine Solar Windows Statuses
    determineSolarWindows(uv, nir);
}

function determineSolarWindows(uv, nir) {
    const now = new Date();
    const hour = now.getHours();
    
    const morningEl = document.getElementById("guideMorning");
    const middayEl = document.getElementById("guideMidday");
    const eveningEl = document.getElementById("guideEvening");
    
    const morningStatus = document.getElementById("statusMorning");
    const middayStatus = document.getElementById("statusMidday");
    const eveningStatus = document.getElementById("statusEvening");
    
    // Reset statuses
    [morningEl, middayEl, eveningEl].forEach(el => el.classList.remove("active-window"));
    [morningStatus, middayStatus, eveningStatus].forEach(el => {
        el.innerText = "Offline";
        el.className = "window-status-tag";
    });
    
    let activeWindow = "none";
    let windowTitleText = "Dusk / Night Period";
    let windowDescText = "Sun is below horizon. Ideal time for cellular recovery & pineal gland melatonin production.";
    let windowIcon = "🌙";
    
    // Approximate windows based on typical solar altitudes and hours
    // (In full production, this maps exactly to sunrise/sunset timestamps, but hourly estimation is highly stable)
    if (hour >= 5 && hour < 8) {
        // Morning NIR (Sunrise + 2 hours)
        morningEl.classList.add("active-window");
        morningStatus.innerText = "Active Now";
        morningStatus.classList.add("active");
        activeWindow = "morning";
        windowTitleText = "Morning NIR Prime Window";
        windowDescText = "Zero UV skin hazard. NIR rays are priming your cellular defense system and boosting mitochondria.";
        windowIcon = "☀️";
    } else if (hour >= 10 && hour <= 14) {
        // Midday (Solar Noon ± 2 hours)
        middayEl.classList.add("active-window");
        middayStatus.innerText = "Active Now";
        middayStatus.classList.add("active");
        activeWindow = "midday";
        windowTitleText = "Midday Vitamin D Synthesis";
        windowDescText = `UV is active (Index ${uv.toFixed(1)}). Get short, controlled exposure to boost Vitamin D, then cover.`;
        windowIcon = "🔋";
    } else if (hour >= 17 && hour < 20) {
        // Evening (Sunset - 2 hours)
        eveningEl.classList.add("active-window");
        eveningStatus.innerText = "Active Now";
        eveningStatus.classList.add("active");
        activeWindow = "evening";
        windowTitleText = "Evening NIR Recovery Window";
        windowDescText = "No UV damage risk. Recharging cellular energy banks and aligning your circadian wind-down.";
        windowIcon = "🌙";
    }
    
    // Update Badge
    document.getElementById("windowTitle").innerText = windowTitleText;
    document.getElementById("windowDesc").innerText = windowDescText;
    document.getElementById("currentWindowBadge").querySelector(".badge-icon").innerText = windowIcon;
}

function drawSolarArc(now) {
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const decimalTime = hour + minutes / 60;
    
    // Estimate relative sun trajectory (Sunrise at 6 AM, Sunset at 8 PM / 20 PM as standard)
    const sunrise = 5.5; 
    const sunset = 20.5;
    const dayLength = sunset - sunrise;
    
    const progressArc = document.getElementById("solarArcProgress");
    const sunNode = document.getElementById("sunNode");
    const sunriseTimeEl = document.getElementById("sunriseTime");
    const sunsetTimeEl = document.getElementById("sunsetTime");
    const solarNoonTimeEl = document.getElementById("solarNoonTime");
    
    sunriseTimeEl.innerText = "Sunrise: 05:30 AM";
    sunsetTimeEl.innerText = "Sunset: 08:30 PM";
    solarNoonTimeEl.innerText = "Solar Noon: 01:00 PM";
    
    if (decimalTime < sunrise || decimalTime > sunset) {
        // Sun is below horizon (Night)
        progressArc.setAttribute("stroke-dashoffset", 500); // Reset arc
        
        // Put sun at left or right horizon
        const isBeforeSunrise = decimalTime < sunrise;
        const x = isBeforeSunrise ? 10 : 290;
        const y = 110;
        sunNode.setAttribute("transform", `translate(${x}, ${y})`);
    } else {
        // Sun is above horizon
        const ratio = (decimalTime - sunrise) / dayLength; // 0 to 1
        
        // Update SVG arc highlights
        // Arc circumference is ~440px. Offset scale goes from 500 (none) to 500 - 440 = 60 (full)
        const circumference = 440;
        const offset = 500 - (ratio * circumference);
        progressArc.setAttribute("stroke-dashoffset", offset);
        
        // Calculate (X, Y) coordinates along the elliptical SVG path
        // Path formula: A 140 140 0 0 1 290 110 starting from (10, 110)
        // Center of arc: X=150, Y=110. Radius: R=140.
        // Solar angle from left (180 deg) to right (0 deg): Angle = 180 - (ratio * 180)
        const angleRad = (Math.PI) - (ratio * Math.PI);
        const x = 150 + 140 * Math.cos(angleRad);
        const y = 110 - 140 * Math.sin(angleRad);
        
        sunNode.setAttribute("transform", `translate(${x}, ${y})`);
    }
}

function updateDynamicAtmosphere(now) {
    const hour = now.getHours();
    const glowEl = document.getElementById("solarGlow");
    
    let glow1, glow2, glow3;
    
    if (hour >= 22 || hour < 4) {
        // Night sky (Luxurious space black and violet)
        glow1 = "#080210";
        glow2 = "#0d051e";
        glow3 = "#030107";
    } else if (hour >= 4 && hour < 6) {
        // Dawn transition
        glow1 = "#511b75";
        glow2 = "#1f0932";
        glow3 = "#0a0214";
    } else if (hour >= 6 && hour < 9) {
        // Sunrise & Morning NIR Golden hour
        glow1 = "#ff7e5f";
        glow2 = "#4e1158";
        glow3 = "#0f021a";
    } else if (hour >= 9 && hour < 16) {
        // Midday Solar Azure Glow
        glow1 = "#ffb03a";
        glow2 = "#144883";
        glow3 = "#091730";
    } else if (hour >= 16 && hour < 19) {
        // Afternoon golden orange
        glow1 = "#f85f73";
        glow2 = "#2e1245";
        glow3 = "#0d0218";
    } else {
        // Evening crimson sunset
        glow1 = "#e63946";
        glow2 = "#1e0b36";
        glow3 = "#050110";
    }
    
    // Apply smooth gradient changes using CSS variables
    glowEl.style.setProperty("--theme-glow-1", glow1);
    glowEl.style.setProperty("--theme-glow-2", glow2);
    glowEl.style.setProperty("--theme-glow-3", glow3);
}

// --- 5. Interactive Session Tracker Core Engine ---
function setupTrackerEventListeners() {
    const startBtn = document.getElementById("startSessionBtn");
    const stopBtn = document.getElementById("stopSessionBtn");
    const cancelBtn = document.getElementById("cancelSessionBtn");
    const clearBtn = document.getElementById("clearHistoryBtn");
    
    startBtn.addEventListener("click", startSolarSession);
    stopBtn.addEventListener("click", stopAndSaveSession);
    cancelBtn.addEventListener("click", cancelActiveSession);
    if (clearBtn) {
        clearBtn.addEventListener("click", clearSavedHistory);
    }
}

function startSolarSession() {
    if (appState.session.isActive) return;
    
    // Set Session Parameters from DOM selectors
    appState.session.skinType = document.getElementById("skinType").value;
    appState.session.clothingLevel = document.getElementById("clothingLevel").value;
    appState.session.isActive = true;
    appState.session.durationSeconds = 0;
    appState.session.accumulatedVitD = 0;
    appState.session.accumulatedNirDose = 0;
    
    // Toggle UI panels
    document.getElementById("trackerSetupPanel").style.display = "none";
    document.getElementById("activeTrackingPanel").style.display = "block";
    document.getElementById("sessionStatusTag").style.display = "block";
    
    // Active navigation focus shifts smoothly to the tracking console
    document.getElementById("activeTrackingPanel").scrollIntoView({ behavior: "smooth" });
    
    // Start active clock ticker (1-second intervals)
    appState.session.timerId = setInterval(tickSessionTimer, 1000);
}

function tickSessionTimer() {
    appState.session.durationSeconds++;
    
    const minutes = Math.floor(appState.session.durationSeconds / 60);
    const seconds = appState.session.durationSeconds % 60;
    
    // Update Timer Display
    document.getElementById("sessionTime").innerText = 
        `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
    // --- 5a. Vitamin D Synthesis Scientific Model ---
    const uvIndex = appState.currentWeather.uvIndex;
    const skinMultiplier = FITZPATRICK_FACTORS[appState.session.skinType];
    const coverage = CLOTHING_COEFFICIENTS[appState.session.clothingLevel];
    
    if (uvIndex >= 1) {
        // Basic physics of Vitamin D3 creation:
        // Exposing 25% of body (T-shirt + shorts) to UV Index 3 in Type II skin produces ~1000 IU in 15 mins.
        // We model: IU_per_second = (UV_index * Base_Rate) * exposed_skin_area / (skin_multiplier_factor)
        const baseRate = 0.5; // calibrate factor
        const vitDPerSecond = (uvIndex * baseRate * coverage.exposedArea) / skinMultiplier;
        
        // Synthesise D3 up to the safety saturation threshold (max synthesis caps at 8000 IU/session)
        if (appState.session.accumulatedVitD < 8000) {
            appState.session.accumulatedVitD += vitDPerSecond;
        }
    } else {
        // Zero UV = Zero Vit D (early morning / night)
        appState.session.accumulatedVitD += 0;
    }
    
    // --- 5b. Systemic Near-Infrared Dose Scientific Model ---
    // Grounded in paper findings that NIR penetrates chest tissues systemically.
    const nirPower = appState.currentWeather.nirPower; // W/m² GHI estimation
    
    if (nirPower > 0) {
        // GHI * 52% gives ground level NIR.
        // exposed body gets 100% NIR. Covered body gets 70% (30% loss through clothes).
        const exposedArea = coverage.exposedArea;
        const clothingTransmission = coverage.nirTransmission;
        
        // Effective NIR irradiance reaching body tissues:
        const effectiveNirIrradiance = nirPower * (exposedArea + (1.0 - exposedArea) * clothingTransmission);
        
        // Convert Irradiance (W/m²) to Dosage (mJ/cm²):
        // 1 W/m² = 1 J/s/m² = 1000 mJ / s / 10000 cm² = 0.1 mJ / cm² / second
        const nirDosePerSecond = effectiveNirIrradiance * 0.1;
        
        appState.session.accumulatedNirDose += nirDosePerSecond;
    }
    
    // --- 5c. UV Safe Limit & Alarm Tracker ---
    // Safe sunlight limits (Minimal Erythemal Dose - sunburn risk)
    // Safe time (mins) to burn = 200 / (UV_Index * Skin_Factor)
    let safeTimeMinutes = Infinity;
    let safeTimeSeconds = Infinity;
    
    if (uvIndex > 0) {
        safeTimeMinutes = 220 / (uvIndex * skinMultiplier);
        safeTimeSeconds = safeTimeMinutes * 60;
    }
    
    updateSessionUi(safeTimeSeconds);
}

function updateSessionUi(safeTimeSeconds) {
    // 1. Update live statistical numbers
    const vitDValue = Math.round(appState.session.accumulatedVitD);
    const nirDoseValue = appState.session.accumulatedNirDose.toFixed(1);
    
    document.getElementById("liveVitD").innerHTML = `${vitDValue} <span class="stat-unit">IU</span>`;
    document.getElementById("liveNirDose").innerHTML = `${nirDoseValue} <span class="stat-unit">mJ/cm²</span>`;
    
    // 2. Update mini progress bars
    const vitDGoalPercent = Math.min((vitDValue / VIT_D_DAILY_GOAL) * 100, 100);
    const nirGoalPercent = Math.min((appState.session.accumulatedNirDose / NIR_DAILY_GOAL) * 100, 100);
    
    document.getElementById("vitDGoalBar").style.width = `${vitDGoalPercent}%`;
    document.getElementById("nirGoalBar").style.width = `${nirGoalPercent}%`;
    
    document.getElementById("liveVitDPercent").innerText = `${Math.round(vitDGoalPercent)}% of ${VIT_D_DAILY_GOAL} IU Goal`;
    
    const liveNirPowerVal = Math.round(appState.currentWeather.nirPower);
    document.getElementById("liveNirPower").innerText = `Absorbing ${liveNirPowerVal} W/m² Infrared`;
    
    // 3. Update Circular Radial Timer Ring
    // Ring circumference is 283 (2 * PI * 45).
    // Let's cycle the ring relative to a nominal 20-minute (1200 seconds) target or Vit D goal.
    const nominalTarget = 1200; 
    const sessionProgress = Math.min(appState.session.durationSeconds / nominalTarget, 1);
    const radialOffset = 283 - (sessionProgress * 283);
    document.getElementById("sessionRadialProgress").setAttribute("stroke-dashoffset", radialOffset);
    
    // 4. Update Safety Indicator Panel (Burn Alarms)
    const alertBox = document.getElementById("safetyAlertBox");
    const alertTitle = document.getElementById("safetyAlertTitle");
    const alertDesc = document.getElementById("safetyAlertDesc");
    const timerGlow = document.getElementById("activeTimerGlow");
    
    alertBox.className = "safety-indicator-box"; // reset
    
    const currentDurationSecs = appState.session.durationSeconds;
    
    if (currentDurationSecs < safeTimeSeconds * 0.7) {
        // Safe Window
        alertBox.classList.add("alert-safe");
        alertTitle.innerText = "UV Exposure Safe";
        alertDesc.innerText = "Highly therapeutic light. Mitochondria system re-energising.";
        timerGlow.style.background = "radial-gradient(circle, rgba(0, 230, 118, 0.2) 0%, rgba(0, 0, 0, 0) 70%)";
    } else if (currentDurationSecs < safeTimeSeconds) {
        // Warning Window (Approaching limit)
        alertBox.classList.add("alert-warning");
        alertTitle.innerText = "Approaching UV Limit";
        alertDesc.innerText = "Skin protection limits nearing. Prepare to seek shade or cover up.";
        timerGlow.style.background = "radial-gradient(circle, rgba(255, 215, 0, 0.2) 0%, rgba(0, 0, 0, 0) 70%)";
    } else {
        // Sunburn danger limit crossed
        alertBox.classList.add("alert-danger");
        alertTitle.innerText = "🚨 Seek Shade Immediately";
        alertDesc.innerText = "Sunburn limits reached. Skin cells are at risk of UV overload.";
        timerGlow.style.background = "radial-gradient(circle, rgba(255, 65, 108, 0.35) 0%, rgba(0, 0, 0, 0) 70%)";
        
        // Vibrate browser device if supported
        if ("vibrate" in navigator) {
            navigator.vibrate([200, 100, 200]);
        }
    }
}

function stopAndSaveSession() {
    if (!appState.session.isActive) return;
    
    clearInterval(appState.session.timerId);
    
    // Create new session object
    const newSession = {
        date: getLocalDateString(new Date()),
        timestamp: Date.now(),
        durationMinutes: Math.round(appState.session.durationSeconds / 60),
        vitD: Math.round(appState.session.accumulatedVitD),
        nirDose: Math.round(appState.session.accumulatedNirDose),
        mode: appState.currentWeather.uvIndex > 3 ? "uv" : "nir"
    };
    
    // Save to State history
    appState.history.push(newSession);
    
    // Persist history to database (localStorage)
    localStorage.setItem("helios_history", JSON.stringify(appState.history));
    
    // Reset tracker variables
    appState.session.isActive = false;
    appState.session.durationSeconds = 0;
    
    // Reset UI Panels
    document.getElementById("trackerSetupPanel").style.display = "block";
    document.getElementById("activeTrackingPanel").style.display = "none";
    document.getElementById("sessionStatusTag").style.display = "none";
    
    // Refresh history logs charts
    initHistory();
    renderHistoryChart();
    
    // Return view back to dashboard cards
    document.querySelector(".solar-arc-container").scrollIntoView({ behavior: "smooth" });
}

function cancelActiveSession() {
    if (!confirm("Are you sure you want to discard this solar session? All recorded data will be lost.")) return;
    
    clearInterval(appState.session.timerId);
    appState.session.isActive = false;
    appState.session.durationSeconds = 0;
    
    document.getElementById("trackerSetupPanel").style.display = "block";
    document.getElementById("activeTrackingPanel").style.display = "none";
    document.getElementById("sessionStatusTag").style.display = "none";
    
    document.querySelector(".solar-arc-container").scrollIntoView({ behavior: "smooth" });
}

// --- 6. Historical Data Logs Manager ---
function initHistory() {
    const saved = localStorage.getItem("helios_history");
    if (saved) {
        appState.history = JSON.parse(saved);
    } else {
        // Pre-populate dynamic mock historical records for the last 5 days relative to today
        const todayMs = Date.now();
        appState.history = [
            { date: getLocalDateString(new Date(todayMs - 5*86400000)), timestamp: todayMs - 5*86400000, durationMinutes: 25, vitD: 1800, nirDose: 140000, mode: "nir" },
            { date: getLocalDateString(new Date(todayMs - 4*86400000)), timestamp: todayMs - 4*86400000, durationMinutes: 15, vitD: 2200, nirDose: 90000, mode: "uv" },
            { date: getLocalDateString(new Date(todayMs - 3*86400000)), timestamp: todayMs - 3*86400000, durationMinutes: 40, vitD: 3400, nirDose: 180000, mode: "uv" },
            { date: getLocalDateString(new Date(todayMs - 2*86400000)), timestamp: todayMs - 2*86400000, durationMinutes: 20, vitD: 0,    nirDose: 110000, mode: "nir" },
            { date: getLocalDateString(new Date(todayMs - 1*86400000)), timestamp: todayMs - 1*86400000, durationMinutes: 30, vitD: 2400, nirDose: 155000, mode: "uv" }
        ];
        localStorage.setItem("helios_history", JSON.stringify(appState.history));
    }
}

function clearSavedHistory() {
    if (!confirm("Are you sure you want to clear all history? This will permanently delete your recorded circadian solar logs.")) return;
    
    // Set localStorage to an empty array so it doesn't trigger mock data again
    localStorage.setItem("helios_history", JSON.stringify([]));
    appState.history = [];
    
    // Refresh the UI and chart
    renderHistoryChart();
}

function renderHistoryChart() {
    const barsContainer = document.getElementById("historyBarsContainer");
    barsContainer.innerHTML = ""; // Clear
    
    // Extract last 7 calendar days
    const daysName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const now = new Date();
    
    let totalWeeklyMinutes = 0;
    let successfulDays = 0;
    
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const dayStr = getLocalDateString(d);
        const dayOfWeek = daysName[d.getDay()];
        
        // Find saved session matching this specific calendar date
        const matches = appState.history.filter(item => item.date === dayStr);
        
        let dailyNirMinutes = 0;
        let dailyUvMinutes = 0;
        let totalMinutes = 0;
        let metGoal = false;
        
        matches.forEach(m => {
            totalMinutes += m.durationMinutes;
            if (m.mode === "uv") {
                dailyUvMinutes += m.durationMinutes;
            } else {
                dailyNirMinutes += m.durationMinutes;
            }
            if (m.vitD >= VIT_D_DAILY_GOAL || m.nirDose >= NIR_DAILY_GOAL) {
                metGoal = true;
            }
        });
        
        totalWeeklyMinutes += totalMinutes;
        if (metGoal) successfulDays++;
        
        // Render custom bar columns
        // Max height visual caps at 60 minutes
        const maxMinutesVisual = 60;
        const nirHeightPercent = Math.min((dailyNirMinutes / maxMinutesVisual) * 100, 100);
        const uvHeightPercent = Math.min((dailyUvMinutes / maxMinutesVisual) * 100, 100);
        const totalHeight = Math.min(nirHeightPercent + uvHeightPercent, 100);
        
        const barColumn = document.createElement("div");
        barColumn.className = "chart-bar-column";
        barColumn.innerHTML = `
            <div class="bar-fill-wrap" style="height: ${totalHeight}%">
                <div class="bar-fill-seg uv-part" style="height: ${(uvHeightPercent/totalHeight)*100 || 0}%"></div>
                <div class="bar-fill-seg nir-part" style="height: ${(nirHeightPercent/totalHeight)*100 || 0}%"></div>
            </div>
            <span class="bar-day-label">${dayOfWeek}</span>
        `;
        
        barsContainer.appendChild(barColumn);
    }
    
    // Update summary text
    const avgMinutes = Math.round(totalWeeklyMinutes / 7);
    document.getElementById("weeklyStatsSummary").innerText = 
        `Avg Outdoors: ${avgMinutes} mins/day • ${successfulDays} of 7 days completed goals`;
}

// --- 7. iOS Progressive Web App (PWA) Install Prompt Logic ---
function setupPwaPrompt() {
    const installPrompt = document.getElementById("installPrompt");
    const closeBtn = document.getElementById("closeInstallPromptBtn");
    
    // Detect iOS standalone check
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone === true;
    
    // If running on iOS Safari in browser mode, display the Add to Home Screen install prompt
    if (isIos && !isStandalone) {
        // Delay visual display slightly for premium feel
        setTimeout(() => {
            installPrompt.style.display = "flex";
        }, 3000);
    }
    
    closeBtn.addEventListener("click", () => {
        installPrompt.style.display = "none";
    });
}
