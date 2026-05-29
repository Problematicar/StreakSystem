let tasksData = null;
let stateData = null;
let paths = null;
let activeTimerInterval = null;
let timerSecondsRemaining = 0;
let isMeditationPrep = false;
let clickBackdoorCount = 0;
let isHudUnlocked = false; // Track local interactivity state

// Circumference for r=14 is 2 * PI * 14 = 87.96
const TIMER_CIRCUMFERENCE = 87.96;

// Audio elements
const soundComplete = document.getElementById('sound-complete');
const soundChime = document.getElementById('sound-chime');
const soundAlarm = document.getElementById('sound-alarm');

// DOM Elements
const hudContainer = document.getElementById('hud-container');
const hudDate = document.getElementById('hud-date');
const streakCount = document.getElementById('streak-count');
const streakMsg = document.getElementById('streak-msg');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressPercentage = document.getElementById('progress-percentage');
const lockToggleBtn = document.getElementById('lock-toggle');
const lockText = document.getElementById('lock-text');
const checklistGrid = document.querySelector('.checklist-grid');
const systemClock = document.getElementById('system-clock');
const failureScreen = document.getElementById('failure-screen');
const failedItemsList = document.getElementById('failed-items-list');
const backdoorResetBtn = document.getElementById('backdoor-reset');

// Load App Initial State
async function init() {
  try {
    paths = await window.api.getPaths();
    
    // Load config and state
    const tasksRaw = await window.api.readFile(paths.tasksPath);
    const stateRaw = await window.api.readFile(paths.statePath);
    
    tasksData = JSON.parse(tasksRaw);
    stateData = JSON.parse(stateRaw);
    
    // Ensure pushupsTarget is initialized
    if (stateData.pushupsTarget === undefined) {
      stateData.pushupsTarget = 25;
    }
    
    // Check Failure Lockout
    if (stateData.isFailedForever) {
      triggerFailureLockout();
      return;
    }
    
    // Check if day has changed (Midnight Reset Engine)
    await runMidnightResetEngine();
    
    // Start periodic clock and day change check
    setInterval(updateClock, 1000);
    setInterval(runMidnightResetEngine, 30000); // Check for midnight every 30 seconds
    
    // Render UI Checklists
    renderChecklists();
    
    // Update Streak and Completion Progress UI
    updateStreakUI();
    updateProgressUI();
    
    // Initialize Interactivity Lock Hover Handler
    initInteractivityHoverHandler();
    
  } catch (error) {
    console.error("Initialization error:", error);
  }
}

// Format time
function updateClock() {
  const now = new Date();
  let hrs = now.getHours().toString().padStart(2, '0');
  let mins = now.getMinutes().toString().padStart(2, '0');
  let secs = now.getSeconds().toString().padStart(2, '0');
  systemClock.textContent = `${hrs}:${mins}:${secs}`;
  
  // Format top-left date dynamically too
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  hudDate.textContent = now.toLocaleDateString('en-US', options);
}

// -------------------------------------------------------------
// INTERACTIVITY HOVER ENGINE
// -------------------------------------------------------------
function initInteractivityHoverHandler() {
  // Start in locked state
  document.body.classList.add('hud-locked');
  
  window.addEventListener('mousemove', (e) => {
    // If the HUD is active/unlocked, it handles all mouse events naturally
    if (isHudUnlocked) return;
    
    // When locked, ONLY the lock toggle button is interactable
    const isOverLock = e.target.closest('#lock-toggle');
    if (isOverLock) {
      window.api.setIgnoreMouseEvents(false);
    } else {
      window.api.setIgnoreMouseEvents(true);
    }
  });

  // Handle clicking Lock/Unlock Button
  lockToggleBtn.addEventListener('click', () => {
    window.api.toggleInteractivity();
  });
  
  // Handle IPC notifications from main process about state change
  window.api.onInteractivityChanged((isUnlocked) => {
    isHudUnlocked = isUnlocked; // Update global state
    
    if (isUnlocked) {
      document.body.classList.remove('hud-locked');
      lockToggleBtn.classList.remove('locked');
      lockToggleBtn.classList.add('unlocked');
      lockText.textContent = 'HUD ACTIVE';
      hudContainer.style.borderColor = 'var(--emerald-glow)';
      hudContainer.style.boxShadow = '0 25px 50px -12px rgba(16, 185, 129, 0.15)';
    } else {
      document.body.classList.add('hud-locked');
      lockToggleBtn.classList.remove('unlocked');
      lockToggleBtn.classList.add('locked');
      lockText.textContent = 'HUD LOCKED';
      hudContainer.style.borderColor = 'var(--border-panel)';
      hudContainer.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.5)';
    }
  });
}

// -------------------------------------------------------------
// MIDNIGHT RESET ENGINE
// -------------------------------------------------------------
async function runMidnightResetEngine() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  
  if (!stateData.lastActiveDate) {
    // First run initialization
    stateData.lastActiveDate = todayStr;
    await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
    return;
  }
  
  if (stateData.lastActiveDate !== todayStr) {
    // A day transition has occurred!
    // Check if the previous day was 100% completed
    const wasPerfect = verifyAllTasksCompleted();
    
    // Check date difference
    const lastActiveDateObj = new Date(stateData.lastActiveDate);
    const todayObj = new Date(todayStr);
    const diffTime = Math.abs(todayObj - lastActiveDateObj);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    // If they missed checking completely for >1 day, or did not complete all tasks on the last active day
    if (!wasPerfect || diffDays > 1) {
      // PERMANENT FAILURE!
      stateData.streak = 0;
      stateData.isFailedForever = true;
      
      // Save failed history JSON and PNG
      const failedDate = stateData.lastActiveDate;
      await saveHistoryJson(failedDate, false);
      await generateHistoryPng(failedDate, false);
      
      // Update state file
      await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
      
      // Trigger Lockout
      triggerFailureLockout();
      try { soundAlarm.play(); } catch (e) {}
    } else {
      // PERFECT SUCCESS!
      // Increment Streak
      stateData.streak += 1;
      
      // Save history JSON and PNG
      const completedDate = stateData.lastActiveDate;
      await saveHistoryJson(completedDate, true);
      await generateHistoryPng(completedDate, true);
      
      // Reset items for the new day
      stateData.lastActiveDate = todayStr;
      resetDailyTasks();
      
      // Save updated state file
      await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
      
      // Refresh UI
      renderChecklists();
      updateStreakUI();
      updateProgressUI();
      
      // Completion chime!
      try { soundChime.play(); } catch (e) {}
    }
  }
}

function verifyAllTasksCompleted() {
  let allDone = true;
  
  tasksData.daily.forEach(category => {
    category.items.forEach(item => {
      const stateVal = stateData.checkedItems[item.id];
      if (item.id === 'physical_pushups') {
        const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
        if ((stateVal || 0) < totalSets) allDone = false;
      } else if (item.type === 'checkbox' || item.type === 'timer') {
        if (stateVal !== true) allDone = false;
      } else if (item.type === 'counter') {
        if ((stateVal || 0) < item.target) allDone = false;
      }
    });
  });
  
  return allDone;
}

function resetDailyTasks() {
  tasksData.daily.forEach(category => {
    category.items.forEach(item => {
      if (item.id === 'physical_pushups') {
        stateData.checkedItems[item.id] = 0;
      } else if (item.type === 'checkbox' || item.type === 'timer') {
        stateData.checkedItems[item.id] = false;
      } else if (item.type === 'counter') {
        stateData.checkedItems[item.id] = 0;
      }
    });
  });
}

async function saveHistoryJson(dateStr, perfect) {
  const historyRecord = {
    date: dateStr,
    streak: stateData.streak,
    perfect: perfect,
    checkedItems: { ...stateData.checkedItems }
  };
  const filePath = `${paths.historyDir}/${dateStr}.json`;
  await window.api.writeFile(filePath, JSON.stringify(historyRecord, null, 2));
}

// -------------------------------------------------------------
// CHECKLIST RENDER ENGINE
// -------------------------------------------------------------
function renderChecklists() {
  checklistGrid.innerHTML = '';
  
  // Arrange in 3 pre-defined columns for neat alignment
  const colContainers = [
    document.createElement('div'), // Column 1
    document.createElement('div'), // Column 2
    document.createElement('div')  // Column 3
  ];
  
  colContainers.forEach(col => col.classList.add('checklist-column', 'category-card-column'));
  
  // Map categories to columns
  // Col 1: Chinese, Clash Royale
  // Col 2: Physical, Mental
  // Col 3: Health, Hygiene
  const colMapping = {
    'Chinese': 0,
    'Clash Royale': 0,
    'Physical': 1,
    'Mental': 1,
    'Health': 2,
    'Hygiene': 2
  };
  
  tasksData.daily.forEach(category => {
    const card = document.createElement('div');
    card.classList.add('category-card');
    card.id = `category-${category.category.replace(/\s+/g, '-').toLowerCase()}`;
    
    const cardTitle = document.createElement('h2');
    cardTitle.textContent = category.category;
    card.appendChild(cardTitle);
    
    const taskList = document.createElement('ul');
    taskList.classList.add('task-list');
    
    let allCategoryItemsDone = true;
    
    category.items.forEach(item => {
      const li = document.createElement('li');
      li.classList.add('task-item');
      li.id = `task-item-${item.id}`;
      
      const mainRow = document.createElement('div');
      mainRow.classList.add('task-main-row');
      
      const isChecked = stateData.checkedItems[item.id];
      
      // Form fields based on task types
      if (item.type === 'checkbox') {
        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('checkbox-container', 'interactive-el');
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = isChecked === true;
        input.dataset.itemId = item.id;
        input.addEventListener('change', (e) => handleCheckboxChange(e, item.id));
        
        const checkmark = document.createElement('span');
        checkmark.classList.add('checkmark');
        
        checkboxLabel.appendChild(input);
        checkboxLabel.appendChild(checkmark);
        mainRow.appendChild(checkboxLabel);
        
        const textSpan = document.createElement('span');
        textSpan.classList.add('task-label');
        textSpan.textContent = item.name;
        mainRow.appendChild(textSpan);
        
        if (isChecked) {
          li.classList.add('done');
        } else {
          allCategoryItemsDone = false;
        }
        
      } else if (item.type === 'counter') {
        if (item.id === 'physical_pushups') {
          const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
          const completedSets = stateData.checkedItems[item.id] || 0;
          
          // Flex container for sets of checkboxes
          const checkboxesContainer = document.createElement('div');
          checkboxesContainer.classList.add('pushups-checkboxes-container');
          checkboxesContainer.style.display = 'flex';
          checkboxesContainer.style.gap = '6px';
          
          for (let i = 0; i < totalSets; i++) {
            const checkboxLabel = document.createElement('label');
            checkboxLabel.classList.add('checkbox-container', 'interactive-el');
            checkboxLabel.title = `Set ${i + 1} of 25 Pushups`;
            
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = completedSets > i;
            input.dataset.itemId = item.id;
            input.dataset.setIndex = i;
            
            input.addEventListener('change', (e) => {
              const isNowChecked = e.target.checked;
              const newCompleted = isNowChecked ? i + 1 : i;
              handlePushupSetsChange(item.id, newCompleted, totalSets);
            });
            
            const checkmark = document.createElement('span');
            checkmark.classList.add('checkmark');
            
            checkboxLabel.appendChild(input);
            checkboxLabel.appendChild(checkmark);
            checkboxesContainer.appendChild(checkboxLabel);
          }
          mainRow.appendChild(checkboxesContainer);
          
          const textSpan = document.createElement('span');
          textSpan.classList.add('task-label');
          textSpan.style.marginLeft = '4px';
          textSpan.textContent = `${stateData.pushupsTarget || 25} Pushups`;
          mainRow.appendChild(textSpan);
          
          const counterBox = document.createElement('div');
          counterBox.classList.add('counter-box');
          
          const btnMinus = document.createElement('button');
          btnMinus.classList.add('counter-btn', 'interactive-el');
          btnMinus.textContent = '−';
          btnMinus.title = "Decrease goal by 25";
          btnMinus.addEventListener('click', () => handlePushupsTargetChange(-25));
          
          const btnPlus = document.createElement('button');
          btnPlus.classList.add('counter-btn', 'interactive-el');
          btnPlus.textContent = '+';
          btnPlus.title = "Increase goal by 25";
          btnPlus.addEventListener('click', () => handlePushupsTargetChange(25));
          
          counterBox.appendChild(btnMinus);
          counterBox.appendChild(btnPlus);
          mainRow.appendChild(counterBox);
          
          if (completedSets >= totalSets) {
            li.classList.add('done');
          } else {
            allCategoryItemsDone = false;
          }
        } else {
          // Standard incremental counter for other future counters
          const value = isChecked || 0;
          
          const textSpan = document.createElement('span');
          textSpan.classList.add('task-label');
          textSpan.textContent = item.name;
          mainRow.appendChild(textSpan);
          
          const counterBox = document.createElement('div');
          counterBox.classList.add('counter-box');
          
          const btnMinus = document.createElement('button');
          btnMinus.classList.add('counter-btn', 'interactive-el');
          btnMinus.textContent = '−';
          btnMinus.addEventListener('click', () => handleCounterChange(item.id, -1, item.target));
          
          const valSpan = document.createElement('span');
          valSpan.classList.add('counter-val');
          valSpan.id = `counter-val-${item.id}`;
          valSpan.textContent = `${value} / ${item.target}`;
          
          const btnPlus = document.createElement('button');
          btnPlus.classList.add('counter-btn', 'interactive-el');
          btnPlus.textContent = '+';
          btnPlus.addEventListener('click', () => handleCounterChange(item.id, 1, item.target));
          
          counterBox.appendChild(btnMinus);
          counterBox.appendChild(valSpan);
          counterBox.appendChild(btnPlus);
          mainRow.appendChild(counterBox);
          
          if (value >= item.target) {
            li.classList.add('done');
          } else {
            allCategoryItemsDone = false;
          }
        }
        
      } else if (item.type === 'timer') {
        // Meditation with smart circular timer
        const timerCompleted = isChecked === true;
        
        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('checkbox-container', 'interactive-el');
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = timerCompleted;
        input.dataset.itemId = item.id;
        input.disabled = false;
        input.addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          const btn = document.getElementById(`timer-btn-${item.id}`);
          const statusLabel = document.getElementById(`timer-status-${item.id}`);
          const timeVal = document.getElementById(`timer-time-${item.id}`);
          
          stateData.checkedItems[item.id] = isChecked;
          
          if (isChecked) {
            li.classList.add('done');
            try { soundComplete.play(); } catch (err) {}
            if (btn) {
              if (btn.classList.contains('running') && activeTimerInterval) {
                clearInterval(activeTimerInterval);
                activeTimerInterval = null;
              }
              btn.textContent = 'RESET';
              btn.classList.remove('running');
            }
            if (statusLabel) statusLabel.textContent = 'COMPLETED';
          } else {
            li.classList.remove('done');
            if (btn) {
              btn.textContent = 'START';
              btn.classList.remove('running');
            }
            if (statusLabel) statusLabel.textContent = 'READY';
            if (timeVal) timeVal.textContent = formatTimeStr(item.duration);
            updateTimerRing(item.id, item.duration, item.duration, false);
          }
          
          updateCategoryCardState(item.id);
          updateProgressUI();
          await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
        });
        
        const checkmark = document.createElement('span');
        checkmark.classList.add('checkmark');
        
        checkboxLabel.appendChild(input);
        checkboxLabel.appendChild(checkmark);
        mainRow.appendChild(checkboxLabel);
        
        const textSpan = document.createElement('span');
        textSpan.classList.add('task-label');
        
        if (item.link) {
          const a = document.createElement('a');
          a.href = '#';
          a.classList.add('interactive-el');
          a.textContent = item.name;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openExternal(item.link);
          });
          textSpan.appendChild(a);
        } else {
          textSpan.textContent = item.name;
        }
        mainRow.appendChild(textSpan);
        
        li.appendChild(mainRow);
        
        // Timer HUD Box
        const timerBox = document.createElement('div');
        timerBox.classList.add('timer-box');
        timerBox.id = `timer-box-${item.id}`;
        
        const ringContainer = document.createElement('div');
        ringContainer.classList.add('timer-ring-container');
        ringContainer.id = `ring-container-${item.id}`;
        
        ringContainer.innerHTML = `
          <svg width="32" height="32">
            <circle class="timer-ring-bg" cx="16" cy="16" r="14"></circle>
            <circle class="timer-ring-progress" id="ring-progress-${item.id}" cx="16" cy="16" r="14" stroke-dasharray="88" stroke-dashoffset="0"></circle>
          </svg>
          <div class="timer-ring-text" id="ring-text-${item.id}">30s</div>
        `;
        
        const detailsBox = document.createElement('div');
        detailsBox.classList.add('timer-details-box');
        
        const timeVal = document.createElement('div');
        timeVal.classList.add('timer-time-val');
        timeVal.id = `timer-time-${item.id}`;
        timeVal.textContent = formatTimeStr(item.duration);
        
        const statusLbl = document.createElement('div');
        statusLbl.classList.add('timer-status-lbl');
        statusLbl.id = `timer-status-${item.id}`;
        statusLbl.textContent = timerCompleted ? 'COMPLETED' : 'READY';
        
        detailsBox.appendChild(timeVal);
        detailsBox.appendChild(statusLbl);
        
        const controlBtn = document.createElement('button');
        controlBtn.classList.add('timer-control-btn', 'interactive-el');
        controlBtn.id = `timer-btn-${item.id}`;
        controlBtn.textContent = timerCompleted ? 'RESET' : 'START';
        controlBtn.addEventListener('click', () => handleTimerClick(item, controlBtn.id));
        
        timerBox.appendChild(ringContainer);
        timerBox.appendChild(detailsBox);
        timerBox.appendChild(controlBtn);
        
        li.appendChild(timerBox);
        
        if (timerCompleted) {
          li.classList.add('done');
        } else {
          allCategoryItemsDone = false;
        }
      }
      
      if (item.type !== 'timer') {
        li.appendChild(mainRow);
      }
      
      taskList.appendChild(li);
    });
    
    card.appendChild(taskList);
    
    if (allCategoryItemsDone) {
      card.classList.add('completed');
    }
    
    // Append to mapped column
    const colIndex = colMapping[category.category] !== undefined ? colMapping[category.category] : 0;
    colContainers[colIndex].appendChild(card);
  });
  
  colContainers.forEach(col => checklistGrid.appendChild(col));
}

// Handle basic checkbox
async function handleCheckboxChange(e, itemId) {
  stateData.checkedItems[itemId] = e.target.checked;
  
  const itemLi = document.getElementById(`task-item-${itemId}`);
  if (e.target.checked) {
    itemLi.classList.add('done');
    try { soundComplete.play(); } catch (e) {}
  } else {
    itemLi.classList.remove('done');
  }
  
  // Recalculate card state
  updateCategoryCardState(itemId);
  
  updateProgressUI();
  await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
}

// Handle counter plus minus
async function handleCounterChange(itemId, delta, target) {
  let val = stateData.checkedItems[itemId] || 0;
  val = Math.max(0, val + delta);
  stateData.checkedItems[itemId] = val;
  
  const valSpan = document.getElementById(`counter-val-${itemId}`);
  if (valSpan) {
    valSpan.textContent = `${val} / ${target}`;
  }
  
  const itemLi = document.getElementById(`task-item-${itemId}`);
  if (val >= target) {
    if (!itemLi.classList.contains('done')) {
      itemLi.classList.add('done');
      try { soundComplete.play(); } catch (e) {}
    }
  } else {
    itemLi.classList.remove('done');
  }
  
  updateCategoryCardState(itemId);
  updateProgressUI();
  await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
}

async function handlePushupsTargetChange(delta) {
  stateData.pushupsTarget = Math.max(25, Math.min(100, (stateData.pushupsTarget || 25) + delta));
  
  const maxSets = Math.floor(stateData.pushupsTarget / 25);
  if ((stateData.checkedItems['physical_pushups'] || 0) > maxSets) {
    stateData.checkedItems['physical_pushups'] = maxSets;
  }
  
  renderChecklists();
  updateCategoryCardState('physical_pushups');
  updateProgressUI();
  await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
}

async function handlePushupSetsChange(itemId, newCompletedSets, totalSets) {
  stateData.checkedItems[itemId] = newCompletedSets;
  
  const itemLi = document.getElementById(`task-item-${itemId}`);
  if (newCompletedSets >= totalSets) {
    if (itemLi && !itemLi.classList.contains('done')) {
      itemLi.classList.add('done');
      try { soundComplete.play(); } catch (e) {}
    }
  } else {
    if (itemLi) itemLi.classList.remove('done');
  }
  
  renderChecklists();
  updateCategoryCardState(itemId);
  updateProgressUI();
  await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
}

function updateCategoryCardState(itemId) {
  // Find which category this belongs to
  let foundCategory = null;
  tasksData.daily.forEach(category => {
    const hasItem = category.items.some(item => item.id === itemId);
    if (hasItem) foundCategory = category;
  });
  
  if (foundCategory) {
    const cardEl = document.getElementById(`category-${foundCategory.category.replace(/\s+/g, '-').toLowerCase()}`);
    if (cardEl) {
      let cardDone = true;
      foundCategory.items.forEach(itm => {
        const stateVal = stateData.checkedItems[itm.id];
        if (itm.id === 'physical_pushups') {
          const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
          if ((stateVal || 0) < totalSets) cardDone = false;
        } else if (itm.type === 'checkbox' || itm.type === 'timer') {
          if (stateVal !== true) cardDone = false;
        } else if (itm.type === 'counter') {
          if ((stateVal || 0) < itm.target) cardDone = false;
        }
      });
      
      if (cardDone) {
        cardEl.classList.add('completed');
      } else {
        cardEl.classList.remove('completed');
      }
    }
  }
}

// -------------------------------------------------------------
// TIMER LOGIC ENGINE
// -------------------------------------------------------------
function formatTimeStr(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimerRing(itemId, current, total, isPrep) {
  const progressCircle = document.getElementById(`ring-progress-${itemId}`);
  const ringText = document.getElementById(`ring-text-${itemId}`);
  const ringContainer = document.getElementById(`ring-container-${itemId}`);
  
  if (progressCircle && ringText) {
    const ratio = current / total;
    const offset = TIMER_CIRCUMFERENCE * (1 - ratio);
    progressCircle.style.strokeDashoffset = offset;
    
    if (isPrep) {
      ringText.textContent = `${current}s`;
      ringContainer.classList.add('prep');
    } else {
      ringText.textContent = `${Math.ceil(current / 60)}m`;
      ringContainer.classList.remove('prep');
    }
  }
}

async function handleTimerClick(item, btnId) {
  const btn = document.getElementById(btnId);
  const statusLabel = document.getElementById(`timer-status-${item.id}`);
  const timeVal = document.getElementById(`timer-time-${item.id}`);
  
  if (stateData.checkedItems[item.id] === true) {
    // If already complete, allow resetting
    stateData.checkedItems[item.id] = false;
    const itemLi = document.getElementById(`task-item-${item.id}`);
    itemLi.classList.remove('done');
    btn.textContent = 'START';
    btn.classList.remove('running');
    statusLabel.textContent = 'READY';
    timeVal.textContent = formatTimeStr(item.duration);
    
    updateTimerRing(item.id, item.duration, item.duration, false);
    updateCategoryCardState(item.id);
    updateProgressUI();
    await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
    return;
  }
  
  if (activeTimerInterval) {
    // A timer is already running somewhere!
    // If it's this one, cancel it. Otherwise, ignore.
    if (btn.classList.contains('running')) {
      clearInterval(activeTimerInterval);
      activeTimerInterval = null;
      btn.textContent = 'START';
      btn.classList.remove('running');
      statusLabel.textContent = 'READY';
      timeVal.textContent = formatTimeStr(item.duration);
      updateTimerRing(item.id, item.duration, item.duration, false);
    }
    return;
  }
  
  // Start Prep Timer Phase
  try { soundChime.play(); } catch (e) {}
  btn.textContent = 'CANCEL';
  btn.classList.add('running');
  
  isMeditationPrep = true;
  timerSecondsRemaining = item.pretime;
  statusLabel.textContent = 'PREPARING...';
  
  updateTimerRing(item.id, timerSecondsRemaining, item.pretime, true);
  
  activeTimerInterval = setInterval(async () => {
    timerSecondsRemaining--;
    
    if (isMeditationPrep) {
      if (timerSecondsRemaining > 0) {
        timeVal.textContent = `00:${timerSecondsRemaining.toString().padStart(2, '0')}`;
        updateTimerRing(item.id, timerSecondsRemaining, item.pretime, true);
      } else {
        // Start Actual Meditation Timer Phase
        try { soundChime.play(); } catch (e) {}
        isMeditationPrep = false;
        timerSecondsRemaining = item.duration;
        statusLabel.textContent = 'MEDITATING...';
        timeVal.textContent = formatTimeStr(timerSecondsRemaining);
        updateTimerRing(item.id, timerSecondsRemaining, item.duration, false);
      }
    } else {
      if (timerSecondsRemaining > 0) {
        timeVal.textContent = formatTimeStr(timerSecondsRemaining);
        updateTimerRing(item.id, timerSecondsRemaining, item.duration, false);
      } else {
        // Meditation Complete!
        clearInterval(activeTimerInterval);
        activeTimerInterval = null;
        
        stateData.checkedItems[item.id] = true;
        const itemLi = document.getElementById(`task-item-${item.id}`);
        itemLi.classList.add('done');
        
        // Update checkbox element UI
        const cb = document.querySelector(`input[data-item-id="${item.id}"]`);
        if (cb) cb.checked = true;
        
        btn.textContent = 'RESET';
        btn.classList.remove('running');
        statusLabel.textContent = 'COMPLETED';
        
        try { soundComplete.play(); } catch (e) {}
        
        // Show native notification
        try {
          new Notification("Streak System HUD", {
            body: "Meditation Protocol Complete! Focus restored."
          });
        } catch (err) {
          console.warn("Failed to show notification:", err);
        }
        
        updateCategoryCardState(item.id);
        updateProgressUI();
        await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
      }
    }
  }, 1000);
}

// -------------------------------------------------------------
// PROGRESS & STREAK UI UPDATER
// -------------------------------------------------------------
function updateStreakUI() {
  streakCount.textContent = stateData.streak;
  
  if (stateData.streak === 0) {
    streakMsg.textContent = "Protocol initialized. Stay hardcore. DO NOT FAIL.";
  } else if (stateData.streak < 3) {
    streakMsg.textContent = "First steps taken. Build the wall of green.";
  } else if (stateData.streak < 7) {
    streakMsg.textContent = "Habit formation in progress. Maintain focus.";
  } else if (stateData.streak < 30) {
    streakMsg.textContent = "Excellent consistency. You are carving discipline.";
  } else {
    streakMsg.textContent = "UNSTOPPABLE FORCE. The background of your environment is perfect.";
  }
}

function updateProgressUI() {
  let totalTasks = 0;
  let completedTasks = 0;
  
  tasksData.daily.forEach(category => {
    category.items.forEach(item => {
      totalTasks++;
      const val = stateData.checkedItems[item.id];
      if (item.id === 'physical_pushups') {
        const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
        if ((val || 0) >= totalSets) completedTasks++;
      } else if (item.type === 'checkbox' || item.type === 'timer') {
        if (val === true) completedTasks++;
      } else if (item.type === 'counter') {
        if ((val || 0) >= item.target) completedTasks++;
      }
    });
  });
  
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  progressBarFill.style.width = `${pct}%`;
  progressPercentage.textContent = `${pct}%`;
}

// -------------------------------------------------------------
// FAILURE LOCKOUT CONTROLLER
// -------------------------------------------------------------
function triggerFailureLockout() {
  failureScreen.classList.remove('hidden');
  
  // Render the missed items as visual proof
  failedItemsList.innerHTML = '';
  
  tasksData.daily.forEach(category => {
    category.items.forEach(item => {
      const val = stateData.checkedItems[item.id];
      let done = false;
      let displayVal = "";
      
      if (item.id === 'physical_pushups') {
        const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
        done = (val || 0) >= totalSets;
        displayVal = done ? `[✓] Done (${stateData.pushupsTarget || 25})` : `[ ] Missed (${stateData.pushupsTarget || 25})`;
      } else if (item.type === 'checkbox' || item.type === 'timer') {
        done = val === true;
        displayVal = done ? "[✓] Done" : "[ ] Missed";
      } else if (item.type === 'counter') {
        const curVal = val || 0;
        done = curVal >= item.target;
        displayVal = `${curVal}/${item.target} Pushups`;
      }
      
      const row = document.createElement('div');
      row.classList.add('failed-item-row', done ? 'done' : 'missed');
      
      row.innerHTML = `
        <span>${category.category}: ${item.name}</span>
        <span>${displayVal}</span>
      `;
      failedItemsList.appendChild(row);
    });
  });
  
  // Secret backdoor reset button configuration (10 clicks)
  backdoorResetBtn.addEventListener('click', async () => {
    clickBackdoorCount++;
    if (clickBackdoorCount >= 10) {
      clickBackdoorCount = 0;
      stateData.isFailedForever = false;
      stateData.streak = 0;
      resetDailyTasks();
      
      const now = new Date();
      stateData.lastActiveDate = now.toISOString().split('T')[0];
      
      await window.api.writeFile(paths.statePath, JSON.stringify(stateData, null, 2));
      
      failureScreen.classList.add('hidden');
      init();
    }
  });
}

// -------------------------------------------------------------
// HISTORY IMAGE GENERATOR (PNG EXPORT CANVAS)
// -------------------------------------------------------------
async function generateHistoryPng(dateStr, perfect) {
  // Create virtual canvas
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  
  // Draw sleek gradient background
  const grad = ctx.createLinearGradient(0, 0, 640, 400);
  grad.addColorStop(0, '#0c0a09'); // Stone 950
  grad.addColorStop(1, '#1c1917'); // Stone 900
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 640, 400);
  
  // Draw glowing grid elements
  ctx.shadowColor = perfect ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)';
  ctx.shadowBlur = 15;
  ctx.lineWidth = 1;
  ctx.strokeStyle = perfect ? '#10b981' : '#ef4444';
  ctx.strokeRect(20, 20, 600, 360);
  ctx.shadowBlur = 0; // Reset shadow
  
  // Draw header text
  ctx.fillStyle = '#f5f5f4'; // Stone 100
  ctx.font = "bold 22px 'Outfit', sans-serif";
  ctx.fillText("STREAK SYSTEM PROTOCOL ARCHIVE", 40, 60);
  
  // Date subtitle
  ctx.fillStyle = '#a8a29e'; // Stone 400
  ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.fillText(`DATE: ${dateStr.toUpperCase()}`, 40, 85);
  
  // Status badge
  const badgeX = 400;
  const badgeY = 44;
  ctx.fillStyle = perfect ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
  ctx.strokeStyle = perfect ? '#10b981' : '#ef4444';
  ctx.lineWidth = 1;
  
  // Draw badge border/fill
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, 200, 42, 6);
  ctx.fill();
  ctx.stroke();
  
  ctx.fillStyle = perfect ? '#10b981' : '#ef4444';
  ctx.font = "bold 13px 'Outfit', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(perfect ? "PERFECT DAY COMPLETED" : "SYSTEM FAILURE STATUS", badgeX + 100, badgeY + 26);
  ctx.textAlign = "left"; // Reset alignment
  
  // Render grid of tasks
  let itemIndex = 0;
  const startX = 40;
  const startY = 130;
  const squareSize = 14;
  const rowHeight = 22;
  const columnWidth = 180;
  
  tasksData.daily.forEach(category => {
    category.items.forEach(item => {
      const val = stateData.checkedItems[item.id];
      let done = false;
      
      if (item.id === 'physical_pushups') {
        const totalSets = Math.floor((stateData.pushupsTarget || 25) / 25);
        done = (val || 0) >= totalSets;
      } else if (item.type === 'checkbox' || item.type === 'timer') {
        done = val === true;
      } else if (item.type === 'counter') {
        done = (val || 0) >= item.target;
      }
      
      const col = itemIndex % 3;
      const row = Math.floor(itemIndex / 3);
      
      const x = startX + col * columnWidth;
      const y = startY + row * rowHeight;
      
      // Draw Square
      ctx.fillStyle = done ? '#10b981' : '#ef4444';
      ctx.beginPath();
      ctx.roundRect(x, y, squareSize, squareSize, 3);
      ctx.fill();
      
      // Draw Check/Cross inside square
      ctx.fillStyle = '#0c0a09';
      ctx.font = "bold 9px 'Inter', sans-serif";
      ctx.fillText(done ? "✓" : "✗", x + 3, y + 10);
      
      // Draw Label
      ctx.fillStyle = '#d6d3d1'; // Stone 300
      ctx.font = "10px 'Outfit', sans-serif";
      
      // Truncate name if it's too long for the card layout
      let name = item.name;
      if (item.id === 'physical_pushups') {
        name = `${stateData.pushupsTarget || 25} Pushups`;
      }
      if (name.length > 20) name = name.substring(0, 18) + "...";
      
      ctx.fillText(name, x + 22, y + 11);
      
      itemIndex++;
    });
  });
  
  // Streak counter summary at the bottom
  ctx.fillStyle = '#a8a29e';
  ctx.font = "bold 11px 'Outfit', sans-serif";
  ctx.fillText(`CURRENT PROTOCOL STREAK: ${stateData.streak} DAYS`, 40, 360);
  
  // Autogenerated stamp
  ctx.fillStyle = '#78716c';
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillText("AUTOGENERATED ARCHIVE SECURE PROTOCOL V1.0", 370, 360);
  
  // Save canvas to filesystem
  const dataUrl = canvas.toDataURL('image/png');
  await window.api.saveHistoryImage(`${dateStr}.png`, dataUrl);
}

// Start Initialization
init();
