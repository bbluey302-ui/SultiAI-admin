import React, { createContext, useState, useEffect, useContext } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api } from '../services/api';
import { useOfflineSync } from '../hooks/useOfflineSync';
import { getLevel, getNumericLevel, DAILY_GOAL_DEFAULT, ACHIEVEMENTS, checkAchievementCondition } from '../constants';

const GameContext = createContext(null);

const STREAK_KEY = 'sultiai_streak';
const XP_KEY = 'sultiai_xp';
const COINS_KEY = 'sultiai_coins';
const HEARTS_KEY = 'sultiai_hearts';
const DAILY_GOAL_KEY = 'sultiai_daily_goal';
const BADGES_KEY = 'sultiai_badges';
const ACHIEVEMENTS_KEY = 'sultiai_achievements';
const LAST_ACTIVE_KEY = 'sultiai_last_active';

/**
 * One id per XP event, minted when the event happens rather than when it is
 * replayed.
 *
 * `public.award_xp` credits exactly once per (user_id, idempotency_key), so this
 * is what makes an offline queue entry safe to replay: the retry carries the
 * original key and is recognised as the same event.
 */
function newXpEventKey(source) {
  return `xp:${source}:${Crypto.randomUUID()}`;
}

export function GameProvider({ children }) {
  const [xp, setXp] = useState(0);
  const [coins, setCoins] = useState(0);
  const [hearts, setHearts] = useState(5);
  const [streak, setStreak] = useState(0);
  const [dailyGoal, setDailyGoal] = useState(DAILY_GOAL_DEFAULT);
  const [dailyXp, setDailyXp] = useState(0);
  const [badges, setBadges] = useState([]);
  const [achievements, setAchievements] = useState([]);
  const [lastActive, setLastActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [levelUpInfo, setLevelUpInfo] = useState(null);

  const { enqueueAction: enqueueSync, flushQueue: processSyncQueue } = useOfflineSync();

  useEffect(() => {
    loadGameState();
  }, []);

  useEffect(() => {
    checkStreak();
  }, [lastActive]);

  const loadGameState = async () => {
    try {
      const [xpVal, coinsVal, heartsVal, streakVal, dailyGoalVal, badgesVal, achievementsVal, lastActiveVal] =
        await Promise.all([
          AsyncStorage.getItem(XP_KEY),
          AsyncStorage.getItem(COINS_KEY),
          AsyncStorage.getItem(HEARTS_KEY),
          AsyncStorage.getItem(STREAK_KEY),
          AsyncStorage.getItem(DAILY_GOAL_KEY),
          AsyncStorage.getItem(BADGES_KEY),
          AsyncStorage.getItem(ACHIEVEMENTS_KEY),
          AsyncStorage.getItem(LAST_ACTIVE_KEY),
        ]);
      if (xpVal) setXp(parseInt(xpVal, 10));
      if (coinsVal) setCoins(parseInt(coinsVal, 10));
      if (heartsVal) setHearts(parseInt(heartsVal, 10));
      if (streakVal) setStreak(parseInt(streakVal, 10));
      if (dailyGoalVal) setDailyGoal(parseInt(dailyGoalVal, 10));
      if (badgesVal) setBadges(JSON.parse(badgesVal));
      if (achievementsVal) setAchievements(JSON.parse(achievementsVal));
      if (lastActiveVal) setLastActive(lastActiveVal);
    } catch (e) {
      console.warn('[GameContext] Failed to load game state:', e.message);
    } finally {
      setLoading(false);
    }
  };

  const getLevelInfo = (currentXp) => {
    const info = getLevel(currentXp);
    return {
      level: info.level,
      label: info.label,
      color: info.color,
      icon: info.icon,
      progress: info.progress,
      xpForNext: info.nextLevelXp,
      xpCurrent: currentXp,
      currentXp: info.currentXp,
    };
  };

  const checkStreak = () => {
    if (!lastActive) return;
    const last = new Date(lastActive);
    const today = new Date();
    const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return;
    if (diffDays === 1) {
      setStreak((prev) => {
        const newStreak = prev + 1;
        AsyncStorage.setItem(STREAK_KEY, String(newStreak));
        return newStreak;
      });
    } else if (diffDays > 1) {
      setStreak(0);
      AsyncStorage.setItem(STREAK_KEY, '0');
    }
    setLastActive(today.toISOString());
    AsyncStorage.setItem(LAST_ACTIVE_KEY, today.toISOString());
    if (diffDays >= 1) {
      setDailyXp(0);
    }
  };

  const addXp = async (amount, source) => {
    const oldLevel = getNumericLevel(xp);
    const newXp = xp + amount;
    const newLevel = getNumericLevel(newXp);
    setXp(newXp);
    setDailyXp((d) => d + amount);
    await AsyncStorage.setItem(XP_KEY, String(newXp));
    const today = new Date().toISOString();
    setLastActive(today);
    await AsyncStorage.setItem(LAST_ACTIVE_KEY, today);
    checkAchievements({ xp: newXp, source });

    // The local AsyncStorage value above is a deliberate offline mirror: it is
    // what makes the XP bar move instantly with no network. It is NOT the
    // balance of record.
    //
    // This used to push the absolute total (`syncToServer({ xp: newXp })`), which
    // made the device authoritative over `learner_profiles.total_xp` - any client
    // could assert any balance. The server now credits the DELTA inside one
    // transaction, and the key minted here makes a replay after the app was
    // closed credit exactly once.
    syncToServer({
      xp_delta: amount,
      source,
      idempotency_key: newXpEventKey(source),
    });

    if (newLevel > oldLevel) {
      setLevelUpInfo({ oldLevel, newLevel, xpGained: amount });
    }
  };

  const addCoins = async (amount) => {
    const newCoins = coins + amount;
    setCoins(newCoins);
    await AsyncStorage.setItem(COINS_KEY, String(newCoins));
  };

  const spendCoins = async (amount) => {
    if (coins < amount) return false;
    const newCoins = coins - amount;
    setCoins(newCoins);
    await AsyncStorage.setItem(COINS_KEY, String(newCoins));
    return true;
  };

  const useHeart = async () => {
    if (hearts <= 0) return false;
    const newHearts = hearts - 1;
    setHearts(newHearts);
    await AsyncStorage.setItem(HEARTS_KEY, String(newHearts));
    return true;
  };

  const refillHearts = async (amount = 5) => {
    setHearts(amount);
    await AsyncStorage.setItem(HEARTS_KEY, String(amount));
  };

  const addBadge = async (badge) => {
    if (badges.find((b) => b.id === badge.id)) return;
    const newBadges = [...badges, { ...badge, earnedAt: new Date().toISOString() }];
    setBadges(newBadges);
    await AsyncStorage.setItem(BADGES_KEY, JSON.stringify(newBadges));
  };

  const addAchievement = async (achievement) => {
    if (achievements.find((a) => a.id === achievement.id)) return;
    const newAchievements = [...achievements, { ...achievement, earnedAt: new Date().toISOString() }];
    setAchievements(newAchievements);
    await AsyncStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(newAchievements));
    addCoins(achievement.coinReward || 50);
    addXp(achievement.xpReward || 100, 'achievement');
  };

  const checkAchievements = async ({ xp: currentXp, source }) => {
    const stats = { xp: currentXp, streak, dailyXp, dailyGoal, source };
    for (const achievement of ACHIEVEMENTS) {
      if (checkAchievementCondition(achievement, stats)) {
        addAchievement({
          id: achievement.id,
          title: achievement.title,
          description: achievement.description,
          icon: achievement.icon,
          xpReward: achievement.xpReward,
          coinReward: achievement.coinReward,
        });
      }
    }
    try {
      await api.checkAchievements({ xp: currentXp, streak, dailyXp, dailyGoal });
    } catch (e) {
      console.warn('[GameContext] Failed to check achievements:', e.message);
    }
  };

  const syncToServer = async (data) => {
    await enqueueSync({
      endpoint: '/api/game/stats',
      method: 'PUT',
      payload: data,
    });
    processSyncQueue();
  };

  const resetDaily = () => {
    setDailyXp(0);
  };

  const clearLevelUp = () => {
    setLevelUpInfo(null);
  };

  return (
    <GameContext.Provider
      value={{
         xp, coins, hearts, streak, dailyGoal, dailyXp, badges, achievements, loading, levelUpInfo,
         addXp, addCoins, spendCoins, useHeart, refillHearts,
         addBadge, addAchievement, setDailyGoal, resetDaily, checkStreak, getLevelInfo,
         clearLevelUp,
      }}
    >
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}
