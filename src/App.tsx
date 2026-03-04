import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MapPin, RefreshCw, Info, Navigation2, Trophy, User, LogOut, X, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Polyline, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Cookies from 'js-cookie';
import { supabase } from './lib/supabase';
import { FALLBACK_PROVINCES, FALLBACK_MUNICIPALITIES } from './data/fallbackData';

// Fix Leaflet default icon issue
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface Municipality {
  nombre: string;
  provincia: string;
  latitud: number;
  longitud: number;
  poblacion: number;
}

type Difficulty = 1 | 2 | 3 | 4 | 5;

const DIFFICULTY_CONFIG: Record<Difficulty, { label: string; min: number; description: string }> = {
  1: { label: 'Nivel 1', min: 20000, description: '> 20.000 hab.' },
  2: { label: 'Nivel 2', min: 10000, description: '> 10.000 hab.' },
  3: { label: 'Nivel 3', min: 5000, description: '> 5.000 hab.' },
  4: { label: 'Nivel 4', min: 3000, description: '> 3.000 hab.' },
  5: { label: 'Nivel 5', min: 0, description: 'Todos' },
};

type GameStatus = 'idle' | 'playing' | 'finished';

interface ProvinceFeature extends GeoJSON.Feature<GeoJSON.Geometry, any> {}

const CONFIG = {
  // Local paths (trying multiple variations)
  PROVINCES_LOCAL: ['/data/provinces.json', './data/provinces.json', 'data/provinces.json'],
  MUNICIPIOS_LOCAL: ['/data/municipalities.json', './data/municipalities.json', 'data/municipalities.json'],
  // Remote fallbacks - Using more reliable sources
  PROVINCES: 'https://raw.githubusercontent.com/codeforgermany/click_that_hood/master/public/data/spain-provinces.geojson',
  PROVINCES_FALLBACK: 'https://cdn.jsdelivr.net/gh/deldar182/geojson-spain@master/provincias.json',
  MUNICIPIOS: 'https://raw.githubusercontent.com/draco-at-git/municipios-espanoles/master/municipios.json',
  MUNICIPIOS_FALLBACK: 'https://cdn.jsdelivr.net/gh/frontid/municipios-espanoles@master/municipios.json',
};


// Haversine formula to calculate distance between two points in km
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number) {
  return deg * (Math.PI / 180);
}

export default function App() {
  const [provinces, setProvinces] = useState<ProvinceFeature[]>([]);
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [difficulty, setDifficulty] = useState<Difficulty>(3);
  const [gameStatus, setGameStatus] = useState<GameStatus>('idle');
  const [currentRound, setCurrentRound] = useState(0);
  const [roundResults, setRoundResults] = useState<number[]>([]);
  const [targetMunicipality, setTargetMunicipality] = useState<Municipality | null>(null);
  const [userClick, setUserClick] = useState<{ lat: number; lon: number } | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [gamesToday, setGamesToday] = useState(0);
  const [showCookieConsent, setShowCookieConsent] = useState(false);
  const [showHiScores, setShowHiScores] = useState(false);
  const [hiScoresData, setHiScoresData] = useState<any[]>([]);
  const [isSavingScore, setIsSavingScore] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<{
    provinces: 'loading' | 'ok' | 'error' | 'fallback';
    municipalities: 'loading' | 'ok' | 'error' | 'fallback';
    details: string[];
  }>({
    provinces: 'loading',
    municipalities: 'loading',
    details: []
  });

  const MAX_ROUNDS = 5;

  const addDetail = (msg: string) => {
    setDataStatus(prev => ({ ...prev, details: [...prev.details, msg] }));
  };

  // Helper to fetch with multiple fallbacks, proxies and retries
  const fetchWithProxy = async (url: string, retries = 0) => {
    const attempt = async (targetUrl: string): Promise<any> => {
      addDetail(`🔍 Solicitando: ${targetUrl}`);
      try {
        const response = await fetch(targetUrl);
        if (response.ok) {
          const data = await response.json();
          addDetail(`✅ Recibido: ${targetUrl}`);
          return data;
        }
        addDetail(`❌ Error HTTP ${response.status}: ${targetUrl}`);
      } catch (e) {
        addDetail(`❌ Error de red: ${targetUrl}`);
      }

      // Proxy as second attempt for remote URLs
      if (targetUrl.startsWith('http')) {
        try {
          addDetail(`🌐 Intentando vía proxy: ${targetUrl}`);
          const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
          const response = await fetch(proxyUrl);
          if (response.ok) {
            const data = await response.json();
            if (data.contents) {
              addDetail(`✅ Recibido vía proxy: ${targetUrl}`);
              return JSON.parse(data.contents);
            }
          }
        } catch (e) {
          addDetail(`❌ Proxy fallido para ${targetUrl}`);
        }
      }
      
      throw new Error(`Failed to fetch ${targetUrl}`);
    };

    for (let i = 0; i <= retries; i++) {
      try {
        return await attempt(url);
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
      }
    }
  };

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | null = null;

    // Auth listener
    if (supabase) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        setUser(session?.user ?? null);
      });

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
      });
      sub = data.subscription;
    }

    // Cookie consent
    const consent = Cookies.get('cookie_consent');
    if (!consent) {
      setShowCookieConsent(true);
    }

    // Game limit tracking
    const today = new Date().toISOString().split('T')[0];
    const games = parseInt(Cookies.get(`games_${today}`) || '0');
    setGamesToday(games);

    return () => {
      if (sub) sub.unsubscribe();
    };
  }, []);

  const incrementGameCount = () => {
    const today = new Date().toISOString().split('T')[0];
    const newCount = gamesToday + 1;
    setGamesToday(newCount);
    Cookies.set(`games_${today}`, newCount.toString(), { expires: 1 });
  };

  const fetchHiScores = async () => {
    if (!supabase) {
      console.warn('Supabase not configured');
      return;
    }
    const { data, error } = await supabase
      .from('hiscores')
      .select('*')
      .order('puntos', { ascending: true }) // Lower average distance is better
      .limit(50);
    
    if (!error && data) {
      setHiScoresData(data);
    }
  };

  const saveHiScore = async (averageDistance: number) => {
    if (!supabase) {
      console.warn('Supabase not configured');
      setSaveError('Supabase no configurado. Las puntuaciones no se guardarán.');
      return;
    }
    
    setIsSavingScore(true);
    setSaveError(null);
    
    try {
      // Get IP
      let ip: string | null = null;
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json', { mode: 'cors' });
        if (ipRes.ok) {
          const ipData = await ipRes.json();
          ip = ipData.ip;
        }
      } catch (ipErr) {
        console.warn('Could not fetch IP:', ipErr);
      }

      const { error } = await supabase.from('hiscores').insert({
        fecha_hora: new Date().toISOString(),
        ip: ip,
        mail: user?.email || null,
        user_id: user?.id || null,
        nivel: difficulty,
        puntos: Math.round(averageDistance)
      });

      if (error) {
        console.error('Error saving hi-score:', error);
        setSaveError(`Error al guardar: ${error.message}`);
      } else {
        console.log('Hi-score saved successfully');
        fetchHiScores();
      }
    } catch (err: any) {
      console.error('Unexpected error saving score:', err);
      setSaveError(`Error inesperado: ${err.message || 'Desconocido'}`);
    } finally {
      setIsSavingScore(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);

    if (!supabase) {
      setAuthError('Error de configuración: Las variables VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY no están definidas en el entorno. Asegúrate de que tengan el prefijo VITE_ en Vercel.');
      setAuthLoading(false);
      return;
    }

    try {
      if (authMode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
          options: {
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        alert('Registro completado. Por favor, verifica tu email (revisa también la carpeta de Spam).');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
      }
      setShowAuthModal(false);
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      addDetail("Iniciando carga de datos...");
      try {
        let provData;
        let provSource: 'ok' | 'fallback' = 'fallback';
        
        // Try local paths first
        const localProvPaths = ['/data/provinces.json', 'data/provinces.json', './data/provinces.json'];
        for (const path of localProvPaths) {
          try {
            addDetail(`Probando ruta local provincias: ${path}`);
            const response = await fetch(path);
            if (response.ok) {
              provData = await response.json();
              addDetail(`✅ Provincias cargadas desde: ${path}`);
              provSource = 'ok';
              break;
            }
          } catch (e) {
            addDetail(`❌ Falló ruta local: ${path}`);
          }
        }

        // If local failed, try remote
        if (!provData) {
          try {
            addDetail(`Probando ruta remota provincias: ${CONFIG.PROVINCES}`);
            provData = await fetchWithProxy(CONFIG.PROVINCES);
            provSource = 'ok';
          } catch {
            try {
              addDetail(`Probando ruta remota fallback provincias: ${CONFIG.PROVINCES_FALLBACK}`);
              provData = await fetchWithProxy(CONFIG.PROVINCES_FALLBACK);
              provSource = 'ok';
            } catch {
              addDetail(`⚠️ Usando datos de provincias de emergencia (hardcoded)`);
              provData = FALLBACK_PROVINCES;
              provSource = 'fallback';
            }
          }
        }
        
        let features: any[] = [];
        if (provData) {
          if (Array.isArray(provData.features)) {
            features = provData.features;
          } else if (Array.isArray(provData)) {
            features = provData;
          } else if (provData.type === 'FeatureCollection' && Array.isArray(provData.features)) {
            features = provData.features;
          }
        }
        
        if (features.length === 0) {
          addDetail("⚠️ No se encontraron provincias, usando fallback");
          features = FALLBACK_PROVINCES.features;
          provSource = 'fallback';
        }

        // Filter out features with invalid geometry to prevent Leaflet crashes
        const validFeatures = features.filter(f => f && f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
        
        addDetail(`✅ ${validFeatures.length} provincias válidas cargadas`);
        setProvinces(validFeatures);
        setDataStatus(prev => ({ ...prev, provinces: provSource }));

        let muniData;
        let muniSource: 'ok' | 'fallback' = 'fallback';
        
        // Try local paths first
        const localMuniPaths = ['/data/municipalities.json', 'data/municipalities.json', './data/municipalities.json'];
        for (const path of localMuniPaths) {
          try {
            addDetail(`Probando ruta local municipios: ${path}`);
            const response = await fetch(path);
            if (response.ok) {
              muniData = await response.json();
              addDetail(`✅ Municipios cargados desde: ${path}`);
              muniSource = 'ok';
              break;
            }
          } catch (e) {
            addDetail(`❌ Falló ruta local: ${path}`);
          }
        }

        if (!muniData) {
          try {
            addDetail(`Probando ruta remota municipios: ${CONFIG.MUNICIPIOS}`);
            muniData = await fetchWithProxy(CONFIG.MUNICIPIOS);
            muniSource = 'ok';
          } catch {
            try {
              addDetail(`Probando ruta remota fallback municipios: ${CONFIG.MUNICIPIOS_FALLBACK}`);
              muniData = await fetchWithProxy(CONFIG.MUNICIPIOS_FALLBACK);
              muniSource = 'ok';
            } catch {
              addDetail(`⚠️ Usando datos de municipios de emergencia (hardcoded)`);
              muniData = FALLBACK_MUNICIPALITIES;
              muniSource = 'fallback';
            }
          }
        }

        setDataStatus(prev => ({ ...prev, municipalities: muniSource }));

        // Normalize data
        let rawMuni: any[] = [];
        if (Array.isArray(muniData)) {
          rawMuni = muniData;
        } else if (muniData && typeof muniData === 'object') {
          rawMuni = muniData.features || muniData.municipios || muniData.data || Object.values(muniData).find(v => Array.isArray(v)) || [];
        }
        
        if (rawMuni.length === 0) {
          addDetail("⚠️ Lista de municipios vacía, usando fallback");
          rawMuni = FALLBACK_MUNICIPALITIES;
        }

        const normalizedMuni = rawMuni.map((m: any) => {
          // GeoJSON Feature
          if (m.type === 'Feature' || (m.properties && m.geometry)) {
            const props = m.properties || {};
            const geom = m.geometry || {};
            const coords = geom.coordinates || [0, 0];
            return {
              nombre: props.ETIQUETA || props.nombre || props.municipio || props.name || "Desconocido",
              provincia: props.provincia || props.province || "Desconocida",
              latitud: parseFloat(coords[1] || 0),
              longitud: parseFloat(coords[0] || 0),
              poblacion: parseInt(props.POBLACION || props.poblacion || props.pop || props.population || 0)
            };
          }
          // Plain object
          return {
            nombre: m.nombre || m.municipio || m.name || m.ETIQUETA || "Desconocido",
            provincia: m.provincia || m.province || "Desconocida",
            latitud: parseFloat(m.latitud || m.lat || m.latitude || 0),
            longitud: parseFloat(m.longitud || m.lon || m.lng || m.longitude || 0),
            poblacion: parseInt(m.poblacion || m.pop || m.population || m.POBLACION || 0)
          };
        }).filter((m: any) => !isNaN(m.latitud) && !isNaN(m.longitud) && (m.latitud !== 0 || m.longitud !== 0));

        if (normalizedMuni.length === 0) {
          addDetail("⚠️ No se pudieron procesar los municipios, usando fallback");
          setMunicipalities(FALLBACK_MUNICIPALITIES);
        } else {
          addDetail(`✅ ${normalizedMuni.length} municipios listos`);
          setMunicipalities(normalizedMuni);
        }
        
        setLoading(false);
      } catch (err: any) {
        console.error("Error loading map data:", err);
        setError(err.message || "Error desconocido al cargar los datos");
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    if (gameStatus === 'playing' && municipalities.length > 0 && !targetMunicipality) {
      const config = DIFFICULTY_CONFIG[difficulty];
      const filtered = municipalities.filter((m: Municipality) => 
        m.poblacion >= config.min
      );
      const randomMuni = filtered[Math.floor(Math.random() * filtered.length)] || municipalities[0];
      setTargetMunicipality(randomMuni);
    }
  }, [municipalities, difficulty, targetMunicipality, gameStatus]);


  const handleMapClick = (lat: number, lon: number) => {
    if (gameStatus !== 'playing' || !targetMunicipality || distance !== null) return;

    const dist = calculateDistance(lat, lon, targetMunicipality.latitud, targetMunicipality.longitud);
    setUserClick({ lat, lon });
    setDistance(dist);
    
    // Record result
    const newResults = [...roundResults, dist];
    setRoundResults(newResults);

    // Auto-advance after a delay
    setTimeout(() => {
      if (currentRound + 1 < MAX_ROUNDS) {
        setCurrentRound(prev => prev + 1);
        nextRound();
      } else {
        setGameStatus('finished');
        const avg = (newResults.reduce((a, b) => a + b, 0) / newResults.length);
        saveHiScore(avg);
      }
    }, 1500);
  };

  const nextRound = () => {
    const config = DIFFICULTY_CONFIG[difficulty];
    const filtered = municipalities.filter((m: Municipality) => 
      m.poblacion >= config.min
    );
    const randomMuni = filtered[Math.floor(Math.random() * filtered.length)] || municipalities[0];
    setTargetMunicipality(randomMuni);
    setUserClick(null);
    setDistance(null);
  };

  const startGame = () => {
    if (!user && gamesToday >= 5) {
      setShowAuthModal(true);
      setAuthError('Has alcanzado el límite de 5 partidas diarias. Regístrate para seguir jugando.');
      return;
    }
    incrementGameCount();
    setGameStatus('playing');
    setCurrentRound(0);
    setRoundResults([]);
    nextRound();
  };

  function MapEvents() {
    const map = useMapEvents({
      click(e) {
        // Only trigger if it's a left click (button 0)
        // Leaflet's click event doesn't always expose the original event's button easily
        // but standard click is usually left click.
        handleMapClick(e.latlng.lat, e.latlng.lng);
      },
      contextmenu(e) {
        // Right click - Leaflet handles contextmenu
        // We don't need to do anything special here if we want default context menu,
        // but the user wants right-click to pan.
        // To do that, we need to enable dragging ONLY when right button is down.
      }
    });

    useEffect(() => {
      if (!map) return;

      // Custom right-click pan implementation
      let isRightDragging = false;
      let lastPos: L.Point | null = null;

      const onMouseDown = (e: MouseEvent) => {
        if (e.button === 2) { // Right click
          isRightDragging = true;
          lastPos = map.mouseEventToContainerPoint(e);
          map.dragging.disable(); // Disable default dragging (which is left click)
          e.preventDefault();
        }
      };

      const onMouseMove = (e: MouseEvent) => {
        if (isRightDragging && lastPos) {
          const currentPos = map.mouseEventToContainerPoint(e);
          const deltaX = lastPos.x - currentPos.x;
          const deltaY = lastPos.y - currentPos.y;
          map.panBy([deltaX, deltaY], { animate: false });
          lastPos = currentPos;
        }
      };

      const onMouseUp = (e: MouseEvent) => {
        if (e.button === 2) {
          isRightDragging = false;
          lastPos = null;
        }
      };

      const container = map.getContainer();
      container.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      container.addEventListener('contextmenu', (e) => e.preventDefault());

      return () => {
        container.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        container.removeEventListener('contextmenu', (e) => e.preventDefault());
      };
    }, [map]);

    return null;
  }

  const provinceStyle = {
    fillColor: '#fef3c7',
    weight: 1,
    opacity: 1,
    color: '#334155',
    fillOpacity: 0.95
  };

  const onEachProvince = (feature: any, layer: any) => {
    layer.on({
      mouseover: (e: any) => {
        const l = e.target;
        l.setStyle({
          fillOpacity: 1.0,
          fillColor: '#fde68a'
        });
      },
      mouseout: (e: any) => {
        const l = e.target;
        l.setStyle({
          fillOpacity: 0.95,
          fillColor: '#fef3c7'
        });
      }
    });
  };

  const geoJsonData = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: provinces
  }), [provinces]);

  const resetGame = (newDifficulty?: Difficulty) => {
    const diff = newDifficulty || difficulty;
    if (newDifficulty) setDifficulty(newDifficulty);
    setGameStatus('idle');
    setRoundResults([]);
    setCurrentRound(0);
    setTargetMunicipality(null);
    setUserClick(null);
    setDistance(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-stone-50">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 animate-spin text-stone-400" />
          <p className="text-stone-500 font-medium">Cargando datos geográficos...</p>
          <div className="mt-8 bg-white/80 p-4 rounded-lg shadow border border-stone-200 max-w-xs text-[10px] font-mono overflow-auto max-h-48">
            <h3 className="font-bold mb-2 border-b pb-1">Log de carga:</h3>
            <div className="space-y-1">
              {Array.isArray(dataStatus.details) && dataStatus.details.map((d, i) => (
                <div key={i} className="border-l-2 border-blue-500 pl-2">{d}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-stone-50">
        <div className="bg-white p-8 rounded-2xl shadow-xl border border-stone-200 max-w-md text-center">
          <div className="bg-red-100 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4">
            <Info className="w-6 h-6 text-red-600" />
          </div>
          <h2 className="text-xl font-bold text-stone-900 mb-2">Error al cargar el juego</h2>
          <p className="text-stone-500 mb-6">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-stone-900 text-white font-bold py-3 rounded-xl hover:bg-stone-800 transition-colors"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden flex flex-col bg-stone-100">
      {/* Header */}
      <header className="h-20 bg-white border-b border-stone-200 flex items-center justify-between px-8 z-20 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-100 p-2 rounded-lg">
            <Navigation2 className="w-6 h-6 text-emerald-600 fill-emerald-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-stone-900">GeoMunicipios</h1>
            <p className="text-xs text-stone-500 font-medium uppercase tracking-wider">España</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Auth Status */}
          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-2 bg-stone-100 px-3 py-1.5 rounded-xl border border-stone-200">
                <User className="w-4 h-4 text-stone-500" />
                <span className="text-xs font-bold text-stone-700">{user.email}</span>
                <button onClick={handleLogout} className="text-stone-400 hover:text-red-500 transition-colors">
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button 
                onClick={() => setShowAuthModal(true)}
                className="text-xs font-bold text-stone-600 hover:text-stone-900 px-3 py-1.5 bg-stone-100 rounded-xl border border-stone-200 transition-colors"
              >
                Entrar / Registro
              </button>
            )}
          </div>

          <button 
            onClick={() => {
              fetchHiScores();
              setShowHiScores(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-amber-100 text-amber-700 rounded-xl font-bold text-xs hover:bg-amber-200 transition-colors"
          >
            <Trophy className="w-4 h-4" />
            Hi Scores
          </button>

          {/* Difficulty Selector */}
          <div className="flex bg-stone-100 p-1 rounded-xl border border-stone-200">
            {(Object.keys(DIFFICULTY_CONFIG).map(Number) as Difficulty[]).map((d) => (
              <button
                key={d}
                onClick={() => resetGame(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  difficulty === d 
                    ? 'bg-white text-stone-900 shadow-sm' 
                    : 'text-stone-400 hover:text-stone-600'
                }`}
                title={DIFFICULTY_CONFIG[d].description}
              >
                {DIFFICULTY_CONFIG[d].label}
              </button>
            ))}
          </div>

          {gameStatus === 'playing' && targetMunicipality && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-stone-900 text-white px-6 py-2 rounded-full shadow-lg flex items-center gap-3"
            >
              <span className="text-stone-400 text-xs font-bold uppercase tracking-widest">Ronda {currentRound + 1}/5:</span>
              <span className="text-lg font-bold">{targetMunicipality.nombre}</span>
              <span className="text-stone-400 text-sm">({targetMunicipality.provincia})</span>
            </motion.div>
          )}

          {gameStatus === 'finished' && (
             <div className="bg-emerald-600 text-white px-6 py-2 rounded-full shadow-lg font-bold">
               ¡Juego Terminado!
             </div>
          )}
          
          <button 
            onClick={() => resetGame()}
            className="p-2 hover:bg-stone-100 rounded-full transition-colors text-stone-600"
            title="Reiniciar"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden p-4 gap-4">
        {/* Left Sidebar: Results */}
        <aside className="w-72 bg-white rounded-3xl shadow-xl border border-stone-200 flex flex-col overflow-hidden">
          <div className="p-6 border-b border-stone-100 bg-stone-50/50">
            <h2 className="text-sm font-black text-stone-900 uppercase tracking-widest flex items-center gap-2">
              <MapPin className="w-4 h-4 text-emerald-600" />
              Resultados
            </h2>
          </div>
          
          <div className="flex-1 overflow-auto p-4">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] font-bold text-stone-400 uppercase tracking-widest border-b border-stone-100">
                  <th className="pb-2 pl-2">Ronda</th>
                  <th className="pb-2 pr-2 text-right">Distancia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-50">
                {[...Array(MAX_ROUNDS)].map((_, i) => (
                  <tr key={i} className={`text-sm ${currentRound === i && gameStatus === 'playing' ? 'bg-emerald-50/50' : ''}`}>
                    <td className="py-3 pl-2 font-medium text-stone-600">Pregunta {i + 1}</td>
                    <td className="py-3 pr-2 text-right font-bold text-stone-900">
                      {roundResults[i] !== undefined ? `${roundResults[i].toFixed(1)} km` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {gameStatus === 'finished' && (
            <div className="p-6 bg-stone-900 text-white">
              <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 mb-1">Media Final</p>
              <p className="text-3xl font-black">
                {(roundResults.reduce((a, b) => a + b, 0) / roundResults.length).toFixed(1)}
                <span className="text-sm font-bold text-stone-400 ml-1">km</span>
              </p>
              
              <div className="mt-4 py-2 px-3 bg-stone-800 rounded-lg text-[10px]">
                {isSavingScore ? (
                  <div className="flex items-center gap-2 text-stone-400">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Guardando puntuación...
                  </div>
                ) : saveError ? (
                  <div className="text-rose-400 font-bold">
                    ⚠️ {saveError}
                  </div>
                ) : (
                  <div className="text-emerald-400 font-bold flex items-center gap-2">
                    <ShieldCheck className="w-3 h-3" />
                    Puntuación guardada
                  </div>
                )}
              </div>

              <button 
                onClick={startGame}
                className="mt-4 w-full bg-emerald-500 hover:bg-emerald-400 text-white font-bold py-2 rounded-xl transition-colors text-sm"
              >
                Jugar de nuevo
              </button>
            </div>
          )}
        </aside>

        {/* Map Area */}
        <main className="flex-1 relative bg-white rounded-3xl overflow-hidden shadow-xl border border-stone-200 group">
          <MapContainer
            center={[40.416775, -3.703790]}
            zoom={6}
            className="w-full h-full cursor-crosshair"
            attributionControl={false}
            dragging={false} // We handle right-click dragging manually
            doubleClickZoom={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            />
            
            {provinces.length > 0 && (
              <GeoJSON 
                key={`provinces-${provinces.length}`}
                data={geoJsonData as any} 
                style={provinceStyle}
                onEachFeature={onEachProvince}
              />
            )}

            <MapEvents />

            {/* Target and User markers as small dots */}
            {userClick && (
              <CircleMarker 
                center={[userClick.lat, userClick.lon]} 
                radius={3}
                pathOptions={{ fillColor: '#1c1917', fillOpacity: 1, color: '#fff', weight: 1.5 }}
              />
            )}
            
            {distance !== null && targetMunicipality && (
              <>
                <CircleMarker 
                  center={[targetMunicipality.latitud, targetMunicipality.longitud]} 
                  radius={3}
                  pathOptions={{ fillColor: '#ef4444', fillOpacity: 1, color: '#fff', weight: 1.5 }}
                />
                <Polyline 
                  positions={[
                    [userClick!.lat, userClick!.lon],
                    [targetMunicipality.latitud, targetMunicipality.longitud]
                  ]}
                  color="#ef4444"
                  weight={2}
                  dashArray="5, 10"
                />
              </>
            )}
          </MapContainer>

          {/* Overlay for Idle State */}
          {gameStatus === 'idle' && (
            <div className="absolute inset-0 z-[1001] bg-stone-900/40 backdrop-blur-sm flex items-center justify-center">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white p-10 rounded-[2.5rem] shadow-2xl text-center max-w-sm border border-stone-100"
              >
                <div className="bg-emerald-100 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6 rotate-3">
                  <Navigation2 className="w-10 h-10 text-emerald-600 fill-emerald-600" />
                </div>
                <h2 className="text-3xl font-black text-stone-900 mb-2 tracking-tight">¿Cuánto conoces España?</h2>
                <p className="text-stone-500 mb-8 text-sm leading-relaxed">
                  Adivina la ubicación de 5 municipios. <br/>
                  Cuanto más cerca, mejor nota.
                </p>
                <button 
                  onClick={startGame}
                  className="w-full bg-stone-900 hover:bg-stone-800 text-white font-black py-4 rounded-2xl transition-all shadow-lg hover:shadow-xl active:scale-95"
                >
                  COMENZAR JUEGO
                </button>
              </motion.div>
            </div>
          )}

          {/* Precision Cursor Indicator (Dynamic via CSS) */}
        </main>
      </div>

      {/* Footer */}
      <footer className="h-10 bg-white border-t border-stone-200 flex items-center justify-between px-8 text-[10px] text-stone-400 font-bold uppercase tracking-widest">
        <div className="flex gap-4">
          <span>Provincias: {provinces.length}</span>
          <span>Municipios: {municipalities.length}</span>
          {!user && <span className="text-amber-500">Partidas hoy: {gamesToday}/5</span>}
        </div>
        <div className="flex gap-4 items-center">
          <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-500" /> Click: Marcar</span>
          <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500" /> Click Derecho: Mover</span>
        </div>
      </footer>

      {/* Cookie Consent Banner */}
      <AnimatePresence>
        {showCookieConsent && (
          <motion.div 
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className="fixed bottom-4 left-4 right-4 z-[2000] bg-stone-900 text-white p-6 rounded-3xl shadow-2xl flex flex-col md:flex-row items-center justify-between gap-4 border border-white/10"
          >
            <div className="flex items-center gap-4">
              <div className="bg-white/10 p-3 rounded-2xl">
                <ShieldCheck className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <h3 className="font-bold text-sm">Privacidad y Cookies</h3>
                <p className="text-xs text-stone-400">Utilizamos cookies para mejorar tu experiencia y gestionar los límites de juego.</p>
              </div>
            </div>
            <button 
              onClick={() => {
                Cookies.set('cookie_consent', 'true', { expires: 365 });
                setShowCookieConsent(false);
              }}
              className="bg-white text-stone-900 px-8 py-2 rounded-xl font-bold text-sm hover:bg-stone-100 transition-colors"
            >
              Aceptar
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* High Scores Modal */}
      <AnimatePresence>
        {showHiScores && (
          <div className="fixed inset-0 z-[2000] bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-8 border-b border-stone-100 flex items-center justify-between bg-amber-50/50">
                <div className="flex items-center gap-4">
                  <div className="bg-amber-100 p-3 rounded-2xl">
                    <Trophy className="w-6 h-6 text-amber-600" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-black text-stone-900 tracking-tight">Mejores Puntuaciones</h2>
                    <p className="text-xs text-stone-500 font-bold uppercase tracking-widest">Top 50 - Menor distancia media</p>
                  </div>
                </div>
                <button onClick={() => setShowHiScores(false)} className="p-2 hover:bg-stone-200 rounded-full transition-colors">
                  <X className="w-6 h-6 text-stone-400" />
                </button>
              </div>
              
              <div className="flex-1 overflow-auto p-8">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] font-bold text-stone-400 uppercase tracking-widest border-b border-stone-100">
                      <th className="pb-4 pl-4">Pos</th>
                      <th className="pb-4">Usuario / IP</th>
                      <th className="pb-4">Fecha</th>
                      <th className="pb-4">Nivel</th>
                      <th className="pb-4 text-right pr-4">Puntos (km)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-50">
                    {hiScoresData.map((score, i) => (
                      <tr key={i} className="hover:bg-stone-50 transition-colors">
                        <td className="py-4 pl-4 font-black text-stone-300">#{i + 1}</td>
                        <td className="py-4">
                          <div className="text-sm font-bold text-stone-900">{score.mail || 'Anónimo'}</div>
                          <div className="text-[10px] text-stone-400 font-mono">{score.ip}</div>
                        </td>
                        <td className="py-4">
                          <div className="text-[10px] text-stone-500">
                            {score.fecha_hora ? new Date(score.fecha_hora).toLocaleDateString() : '-'}
                          </div>
                          <div className="text-[9px] text-stone-400">
                            {score.fecha_hora ? new Date(score.fecha_hora).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                          </div>
                        </td>
                        <td className="py-4">
                          <span className="px-2 py-1 bg-stone-100 rounded text-[10px] font-bold text-stone-600">Nivel {score.nivel}</span>
                        </td>
                        <td className="py-4 text-right pr-4 font-black text-emerald-600">{score.puntos}</td>
                      </tr>
                    ))}
                    {hiScoresData.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-stone-400 italic">No hay puntuaciones registradas todavía.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Auth Modal */}
      <AnimatePresence>
        {showAuthModal && (
          <div className="fixed inset-0 z-[2000] bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden p-10"
            >
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h2 className="text-3xl font-black text-stone-900 tracking-tight">
                    {authMode === 'login' ? 'Bienvenido' : 'Crea tu cuenta'}
                  </h2>
                  <p className="text-stone-500 text-sm mt-1">
                    {authMode === 'login' ? 'Identifícate para guardar tus puntuaciones.' : 'Juega sin límites y compite en el ranking.'}
                  </p>
                </div>
                <button onClick={() => setShowAuthModal(false)} className="p-2 hover:bg-stone-100 rounded-full transition-colors">
                  <X className="w-6 h-6 text-stone-400" />
                </button>
              </div>

              {authError && (
                <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm">
                  <Info className="w-4 h-4 shrink-0" />
                  <p>{authError}</p>
                </div>
              )}

              <form onSubmit={handleAuth} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-1.5 ml-1">Email</label>
                  <input 
                    type="email" 
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="tu@email.com"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-1.5 ml-1">Contraseña</label>
                  <input 
                    type="password" 
                    required
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="w-full bg-stone-50 border border-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="••••••••"
                  />
                </div>
                <button 
                  disabled={authLoading}
                  className="w-full bg-stone-900 hover:bg-stone-800 text-white font-black py-4 rounded-2xl transition-all shadow-lg hover:shadow-xl active:scale-95 disabled:opacity-50 mt-4"
                >
                  {authLoading ? 'Cargando...' : (authMode === 'login' ? 'ENTRAR' : 'REGISTRARSE')}
                </button>
              </form>

              <div className="mt-8 pt-8 border-t border-stone-100 text-center">
                <button 
                  onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
                  className="text-sm font-bold text-stone-400 hover:text-stone-900 transition-colors"
                >
                  {authMode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Entra'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .leaflet-container {
          cursor: crosshair !important;
        }
        .cursor-crosshair {
          cursor: crosshair !important;
        }
      `}</style>
    </div>
  );
}
