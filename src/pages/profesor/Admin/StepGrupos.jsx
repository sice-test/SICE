import { useEffect, useMemo, useRef, useState } from 'react'
import {
  obtenerEstudiantesSinGrupo,
  obtenerGruposBase,
  obtenerHemisemestres,
  eliminarGrupo,
  agregarIntegranteGrupo,
  moverIntegrante,
  actualizarTemaGrupo,
  actualizarRolesGrupo,
  etiquetaHemisemestre
} from '../../../lib/data.js'
import {
  Panel,
  Button,
  Aviso,
  Spinner,
  Campo,
  Input,
  Select,
  Badge
} from '../../../components/ui/index.jsx'
import { SelectorParalelo } from './StepParalelo.jsx'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import EditIcon from '@mui/icons-material/Edit'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import PersonAddIcon from '@mui/icons-material/PersonAdd'
import DeleteIcon from '@mui/icons-material/Delete'
import SaveIcon from '@mui/icons-material/Save'
import RefreshIcon from '@mui/icons-material/Refresh'
import { useRealtimeRefresh } from '../../../lib/realtime.js'
import BuilderNuevoGrupo from '../../../components/profesor/admin/BuilderNuevoGrupo.jsx'
import { notificar } from '../../../lib/notifications.js'

// Firma comparable de la composición de un grupo (integrantes, rol y líder).
function firmaMiembros(miembros) {
  return (miembros ?? [])
    .map(m => `${m.usuarioId}:${m.rolGrupo}:${m.lider ? 1 : 0}`)
    .sort()
    .join('|')
}

function mismosIntegrantes(a, b) {
  const idsA = new Set((a ?? []).map(m => m.usuarioId))
  const idsB = new Set((b ?? []).map(m => m.usuarioId))
  return idsA.size === idsB.size && [...idsA].every(id => idsB.has(id))
}

export default function StepGrupos({
  paraleloId,
  paralelos,
  hemisemestres,
  hemisemestreInicialId,
  onParaleloSeleccionado,
  onRetroceder
}) {
  const [sinGrupoPorHemi, setSinGrupoPorHemi] = useState(new Map())
  const [gruposBase, setGruposBase] = useState([])
  const [hemiId, setHemiId] = useState(hemisemestreInicialId ?? null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [modoEditar, setModoEditar] = useState(null) // grupoId del grupo en edición de tema
  const [modoEditarRoles, setModoEditarRoles] = useState(null)
  const [modoMover, setModoMover] = useState(null) // { usuarioId, grupoOrigenId }
  const [modoAgregar, setModoAgregar] = useState(null)
  const [modoEdicion, setModoEdicion] = useState(false)
  const [actualizando, setActualizando] = useState(false)
  const cargarVersionRef = useRef(0)
  const operacionEnProgresoRef = useRef(false)
  const paraleloActual = paralelos.find(
    p => (p.id ?? p.paraleloId) === paraleloId
  )
  const catalogoFijo = [
    'Sistemas Digitales',
    'Plataformas de Hardware'
  ].includes(paraleloActual?.materiaNombre)

  // Hemisemestre en edición y el otro (para "aplicar también en…").
  const hemiActual =
    hemisemestres.find(h => h.id === hemiId) ?? hemisemestres[0] ?? null
  const otroHemi = hemisemestres.find(h => h.id !== hemiActual?.id) ?? null
  const claveHemisemestres = hemisemestres.map(h => h.id).join(',')

  const sinGrupo = sinGrupoPorHemi.get(hemiActual?.id) ?? []
  const sinGrupoOtroHemi = otroHemi
    ? (sinGrupoPorHemi.get(otroHemi.id) ?? [])
    : []

  // Vista del hemisemestre activo: `miembros` es la membresía de ese hemi.
  const grupos = useMemo(
    () =>
      gruposBase.map(g => {
        const miembros = g.miembrosPorHemi?.[hemiActual?.id] ?? []
        const miembrosOtroHemi = otroHemi
          ? (g.miembrosPorHemi?.[otroHemi.id] ?? [])
          : null
        return {
          ...g,
          miembros,
          miembrosOtroHemi,
          sincronizado:
            !otroHemi ||
            firmaMiembros(miembros) === firmaMiembros(miembrosOtroHemi)
        }
      }),
    [gruposBase, hemiActual?.id, otroHemi?.id]
  )

  function hemisDestino(aplicarAmbos) {
    return aplicarAmbos && otroHemi ? [hemiActual, otroHemi] : [hemiActual]
  }

  const siguienteNumero = useMemo(() => {
    if (grupos.length === 0) return 1
    const nums = grupos
      .map(g => Number(g.numero))
      .filter(n => Number.isInteger(n) && n > 0)
    return nums.length > 0 ? Math.max(...nums) + 1 : 1
  }, [grupos])

  const realtimeSubscriptions = useMemo(
    () => [
      {
        event: '*',
        schema: 'public',
        table: 'matriculas',
        filter: paraleloId ? `paralelo_id=eq.${paraleloId}` : undefined
      },
      {
        event: '*',
        schema: 'public',
        table: 'grupos',
        filter: paraleloId ? `paralelo_id=eq.${paraleloId}` : undefined
      },
      { event: '*', schema: 'public', table: 'grupo_miembros' },
      { event: '*', schema: 'public', table: 'grupo_temas' }
    ],
    [paraleloId]
  )

  useEffect(() => {
    cargar()
  }, [paraleloId, claveHemisemestres])

  // Si cambia el paralelo, conserva el hemi elegido solo si sigue existiendo.
  useEffect(() => {
    if (!hemisemestres.some(h => h.id === hemiId)) {
      setHemiId(
        hemisemestres.find(h => h.id === hemisemestreInicialId)?.id ??
          hemisemestres[0]?.id ??
          null
      )
    }
  }, [claveHemisemestres])

  useEffect(() => {
    if (!modoEdicion) {
      setModoEditar(null)
      setModoEditarRoles(null)
      setModoMover(null)
      setModoAgregar(null)
    }
  }, [modoEdicion])

  // Los paneles abiertos corresponden a un hemisemestre concreto.
  useEffect(() => {
    setModoEditarRoles(null)
    setModoMover(null)
    setModoAgregar(null)
  }, [hemiActual?.id])

  useRealtimeRefresh({
    subscriptions: realtimeSubscriptions,
    enabled: Boolean(paraleloId && !modoEdicion),
    debounceMs: 500,
    onChange: ({ silent } = {}) => {
      if (operacionEnProgresoRef.current) return
      cargar(silent)
    }
  })

  async function seleccionarParalelo(id) {
    try {
      const nuevosHemisemestres = await obtenerHemisemestres(id)
      onParaleloSeleccionado({
        paraleloId: id,
        hemisemestres: nuevosHemisemestres
      })
    } catch (e) {
      setError(e.message)
      notificar.error(e)
    }
  }

  async function cargar(silenciosa = false) {
    const version = ++cargarVersionRef.current
    if (!silenciosa) setCargando(true)
    setError('')
    try {
      const [sg, gs] = await Promise.all([
        obtenerEstudiantesSinGrupo(paraleloId, hemisemestres),
        obtenerGruposBase(paraleloId)
      ])
      if (version !== cargarVersionRef.current) return

      // Deduplicar grupos defensivamente por id y ordenar por número
      const mapaGrupos = new Map()
      for (const g of gs) {
        if (!mapaGrupos.has(g.id)) {
          mapaGrupos.set(g.id, g)
        }
      }
      const gruposFinales = [...mapaGrupos.values()].sort(
        (a, b) => a.numero - b.numero
      )

      // Garantizar consistencia: ningún estudiante asignado a un grupo en un
      // hemisemestre debe aparecer como sin grupo en ese hemisemestre.
      const sinGrupoFinal = new Map(
        hemisemestres.map(h => {
          const idsConGrupo = new Set(
            gruposFinales.flatMap(g =>
              (g.miembrosPorHemi?.[h.id] ?? []).map(m => m.usuarioId)
            )
          )
          return [
            h.id,
            (sg.get(h.id) ?? []).filter(
              est => !idsConGrupo.has(est.usuarioId)
            )
          ]
        })
      )

      setSinGrupoPorHemi(sinGrupoFinal)
      setGruposBase(gruposFinales)
    } catch (e) {
      if (version === cargarVersionRef.current) {
        setError(e.message)
        notificar.error(e)
      }
    } finally {
      if (version === cargarVersionRef.current) {
        setCargando(false)
      }
    }
  }

  async function handleActualizarManual() {
    setActualizando(true)
    try {
      await cargar(true)
    } finally {
      setActualizando(false)
    }
  }

  // if (cargando) return <LoadingSkeleton variant="admin-grupos" />
    if (cargando) return (
    <div className="flex items-center justify-center gap-2 h-64 text-sm text-ink-soft">
      <Spinner className="w-4 h-4" /> Cargando…
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="flex-1">
            <SelectorParalelo
              paralelos={paralelos}
              value={paraleloId}
              onChange={seleccionarParalelo}
            />
          </div>
          {hemisemestres.length > 1 && (
            <SelectorHemisemestre
              hemisemestres={hemisemestres}
              value={hemiActual?.id}
              onChange={setHemiId}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleActualizarManual}
            disabled={cargando || actualizando}
            title="Actualizar grupos y estudiantes sin grupo"
            className="self-start sm:self-end shrink-0"
          >
            <RefreshIcon
              className={`w-4 h-4 ${actualizando ? 'animate-spin' : ''}`}
            />{' '}
            Actualizar
          </Button>
        </div>
      </Panel>

      {error && <Aviso variant="red">{error}</Aviso>}

      {catalogoFijo && (
        <Aviso dismissible>
          Este paralelo usa siete grupos y temas fijos. Los estudiantes realizan
          su propia asignación desde «Mi grupo» mientras la etapa esté abierta.
        </Aviso>
      )}

      {otroHemi && grupos.length > 0 && (
        <Aviso dismissible>
          Estás viendo los grupos del {hemiActual?.nombre?.toLowerCase()}. Al crearse, los
          grupos y roles son iguales en ambos hemisemestres; los cambios que
          hagas aquí se aplican solo a {etiquetaHemisemestre(hemiActual)}, salvo
          que marques «Aplicar también en {etiquetaHemisemestre(otroHemi)}».
        </Aviso>
      )}

      {sinGrupo.length === 0 && grupos.length > 0 && (
        <Aviso variant="green">
          Todos los estudiantes matriculados están asignados a un grupo en{' '}
          {etiquetaHemisemestre(hemiActual)}.
        </Aviso>
      )}
      {sinGrupo.length > 0 && grupos.length > 0 && (
        <Aviso variant="amber">
          Hay {sinGrupo.length} estudiante
          {sinGrupo.length === 1 ? '' : 's'} matriculado
          {sinGrupo.length === 1 ? '' : 's'} sin grupo en{' '}
          {etiquetaHemisemestre(hemiActual)}. Debe
          {sinGrupo.length === 1 ? '' : 'n'} ingresar a un grupo antes de
          finalizar la asignación.
        </Aviso>
      )}

      {/* Builder: crear nuevo grupo */}
      {!catalogoFijo && sinGrupo.length > 0 && (
        <BuilderNuevoGrupo
          sinGrupo={sinGrupo}
          sinGrupoOtroHemi={sinGrupoOtroHemi}
          hemiActual={hemiActual}
          otroHemi={otroHemi}
          siguienteNumero={siguienteNumero}
          paraleloId={paraleloId}
          hemisemestres={hemisemestres}
          onOperacionInicio={() => {
            operacionEnProgresoRef.current = true
          }}
          onOperacionFin={() => {
            operacionEnProgresoRef.current = false
          }}
          onCreado={() => cargar(true)}
          onError={mensaje => {
            setError(mensaje)
            notificar.error(mensaje)
          }}
        />
      )}

      {/* Lista de grupos existentes */}
      {grupos.length > 0 && (
        <div>
          <div className="sticky top-[2.5rem] md:top-0 z-30 -mx-5 px-5 py-3 mb-3 border-b border-black/[0.08] dark:border-white/10 bg-[#f8fafd]/95 dark:bg-slate-900/95 backdrop-blur-sm sm:-mx-10 sm:px-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3>
                Grupos creados
                {otroHemi && (
                  <span className="text-ink-soft font-normal">
                    {' '}
                    · {etiquetaHemisemestre(hemiActual)}
                  </span>
                )}
              </h3>
              <label className="inline-flex items-center gap-2 self-start sm:self-auto cursor-pointer text-sm font-semibold text-ink-mid">
                <input
                  type="checkbox"
                  checked={modoEdicion}
                  onChange={e => setModoEdicion(e.target.checked)}
                  className="w-4 h-4 accent-gold"
                />
                Modo edición
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {grupos.map(g => (
              <TarjetaGrupo
                key={g.id}
                grupo={g}
                grupos={grupos}
                estudiantesDisponibles={sinGrupo}
                estudiantesDisponiblesOtroHemi={sinGrupoOtroHemi}
                hemisemestres={hemisemestres}
                hemiActual={hemiActual}
                otroHemi={otroHemi}
                modoEditar={modoEditar === g.id}
                modoEditarRoles={modoEditarRoles === g.id}
                modoAgregar={modoAgregar === g.id}
                modoMover={modoMover?.grupoOrigenId === g.id ? modoMover : null}
                modoEdicion={modoEdicion}
                catalogoFijo={catalogoFijo}
                onEditarTema={() => setModoEditar(g.id)}
                onCerrarEditar={() => setModoEditar(null)}
                onEditarRoles={() => setModoEditarRoles(g.id)}
                onCerrarEditarRoles={() => setModoEditarRoles(null)}
                onIniciarAgregar={() => setModoAgregar(g.id)}
                onCerrarAgregar={() => setModoAgregar(null)}
                onDeshacer={async () => {
                  operacionEnProgresoRef.current = true
                  try {
                    await eliminarGrupo(g.id)
                    await cargar(true)
                    notificar.exito(`Grupo ${g.numero} deshecho correctamente.`)
                  } catch (e) {
                    setError(e.message)
                    notificar.error(e)
                  } finally {
                    operacionEnProgresoRef.current = false
                  }
                }}
                onAgregar={async (usuarioId, rolGrupo, aplicarAmbos) => {
                  operacionEnProgresoRef.current = true
                  try {
                    await agregarIntegranteGrupo({
                      grupoId: g.id,
                      usuarioId,
                      rolGrupo,
                      hemisemestres: hemisDestino(aplicarAmbos)
                    })
                    setModoAgregar(null)
                    await cargar(true)
                  } catch (e) {
                    setError(e.message)
                    notificar.error(e)
                  } finally {
                    operacionEnProgresoRef.current = false
                  }
                }}
                onIniciarMover={usuarioId =>
                  setModoMover({ usuarioId, grupoOrigenId: g.id })
                }
                onCancelarMover={() => setModoMover(null)}
                onMoverA={async (
                  grupoDestinoId,
                  rolGrupo,
                  nuevoLiderOrigenId,
                  nuevoEvaluadorOrigenId,
                  aplicarAmbos
                ) => {
                  operacionEnProgresoRef.current = true
                  try {
                    await moverIntegrante({
                      usuarioId: modoMover.usuarioId,
                      grupoOrigenId: modoMover.grupoOrigenId,
                      grupoDestinoId,
                      rolGrupo,
                      nuevoLiderOrigenId,
                      nuevoEvaluadorOrigenId,
                      hemisemestres: hemisDestino(aplicarAmbos)
                    })
                    setModoMover(null)
                    await cargar(true)
                  } catch (e) {
                    setError(e.message)
                    notificar.error(e)
                  } finally {
                    operacionEnProgresoRef.current = false
                  }
                }}
                onTemaGuardado={() => cargar(true)}
                onError={mensaje => {
                  setError(mensaje)
                  notificar.error(mensaje)
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-start mt-2">
        <Button variant="outline" onClick={onRetroceder}>
          <>
            <ArrowBackIcon className="w-4 h-4" /> Volver
          </>
        </Button>
      </div>
    </div>
  )
}

function SelectorHemisemestre({ hemisemestres, value, onChange }) {
  return (
    <Campo label="Hemisemestre en edición">
      <div className="inline-flex gap-1 bg-surface rounded-sm p-0.5 border border-black/10 dark:border-white/10">
        {hemisemestres.map(h => (
          <button
            key={h.id}
            type="button"
            onClick={() => onChange(h.id)}
            aria-pressed={value === h.id}
            className={`text-xs font-semibold px-3 py-1.5 rounded-[4px] transition-colors ${
              value === h.id
                ? 'bg-gold text-white'
                : 'text-ink-soft hover:text-ink-mid'
            }`}
          >
            {etiquetaHemisemestre(h)}
          </button>
        ))}
      </div>
    </Campo>
  )
}

// Casilla "Aplicar también en Hemi N". Si la operación no puede replicarse
// en el otro hemisemestre, se muestra deshabilitada con el motivo.
function CheckOtroHemi({ otroHemi, checked, onChange, disponible, motivo }) {
  if (!otroHemi) return null
  return (
    <div className="mt-3">
      <label
        className={`inline-flex items-center gap-2 text-xs font-semibold ${
          disponible
            ? 'text-ink-mid cursor-pointer'
            : 'text-ink-soft opacity-70 cursor-not-allowed'
        }`}
      >
        <input
          type="checkbox"
          checked={disponible && checked}
          disabled={!disponible}
          onChange={e => onChange(e.target.checked)}
          className="w-3.5 h-3.5 accent-gold"
        />
        Aplicar también en {etiquetaHemisemestre(otroHemi)}
      </label>
      {!disponible && motivo && (
        <p className="text-xs text-ink-soft mt-1">{motivo}</p>
      )}
    </div>
  )
}

// ---- Tarjeta de grupo existente (editar tema / mover integrante) ----
function TarjetaGrupo({
  grupo,
  grupos,
  estudiantesDisponibles,
  estudiantesDisponiblesOtroHemi,
  hemisemestres,
  hemiActual,
  otroHemi,
  modoEditar,
  modoEditarRoles,
  modoMover,
  modoAgregar,
  modoEdicion,
  catalogoFijo,
  onEditarTema,
  onCerrarEditar,
  onEditarRoles,
  onCerrarEditarRoles,
  onIniciarAgregar,
  onCerrarAgregar,
  onDeshacer,
  onAgregar,
  onIniciarMover,
  onCancelarMover,
  onMoverA,
  onTemaGuardado,
  onError
}) {
  const [temas, setTemas] = useState(
    // Inicializa con el primer miembro de grupo_temas si lo hay
    // (en StepGrupos no lo traemos; se edita por separado)
    {}
  )
  const [guardandoTema, setGuardandoTema] = useState(false)
  const [roles, setRoles] = useState({})
  const [guardandoRoles, setGuardandoRoles] = useState(false)
  const [errorRoles, setErrorRoles] = useState('')
  const [estudianteAgregar, setEstudianteAgregar] = useState('')
  const [rolAgregar, setRolAgregar] = useState('expositor')
  const [guardandoAgregar, setGuardandoAgregar] = useState(false)
  const [errorAgregar, setErrorAgregar] = useState('')
  const [confirmandoDeshacer, setConfirmandoDeshacer] = useState(false)
  const [guardandoDeshacer, setGuardandoDeshacer] = useState(false)
  // "Aplicar también en el otro hemi": por defecto activo si el grupo
  // sigue siendo igual en ambos hemisemestres.
  const [rolesAmbos, setRolesAmbos] = useState(grupo.sincronizado)
  const [agregarAmbos, setAgregarAmbos] = useState(grupo.sincronizado)
  const [moverAmbos, setMoverAmbos] = useState(grupo.sincronizado)

  // Para el diálogo de mover
  const [grupoDestino, setGrupoDestino] = useState('')
  const [rolDestino, setRolDestino] = useState('expositor')
  const [nuevoLiderOrigenId, setNuevoLiderOrigenId] = useState('')
  const [nuevoEvaluadorOrigenId, setNuevoEvaluadorOrigenId] = useState('')
  const [errorMovimiento, setErrorMovimiento] = useState('')

  useEffect(() => {
    setGrupoDestino('')
    setRolDestino('expositor')
    setNuevoLiderOrigenId('')
    setNuevoEvaluadorOrigenId('')
    setErrorMovimiento('')
    setMoverAmbos(grupo.sincronizado)
  }, [modoMover?.usuarioId])

  useEffect(() => {
    if (modoAgregar) {
      setEstudianteAgregar('')
      setRolAgregar('expositor')
      setErrorAgregar('')
      setAgregarAmbos(grupo.sincronizado)
    }
  }, [modoAgregar])

  useEffect(() => {
    if (modoEditarRoles) {
      setRoles(
        Object.fromEntries(
          grupo.miembros.map(m => [
            m.usuarioId,
            { rolGrupo: m.rolGrupo, lider: m.lider }
          ])
        )
      )
      setErrorRoles('')
    }
  }, [modoEditarRoles, grupo.miembros])

  useEffect(() => {
    if (modoEditarRoles) setRolesAmbos(grupo.sincronizado)
  }, [modoEditarRoles])

  const nombreHemiActual = etiquetaHemisemestre(hemiActual)
  const nombreOtroHemi = otroHemi ? etiquetaHemisemestre(otroHemi) : ''

  // Roles: replicables solo si los integrantes son los mismos en ambos hemis.
  const rolesReplicables =
    Boolean(otroHemi) &&
    mismosIntegrantes(grupo.miembros, grupo.miembrosOtroHemi)
  const aplicarRolesAmbos = rolesReplicables && rolesAmbos

  // Añadir: replicable si el estudiante tampoco tiene grupo en el otro hemi.
  const agregarReplicable =
    Boolean(otroHemi) &&
    (!estudianteAgregar ||
      estudiantesDisponiblesOtroHemi.some(
        e => e.usuarioId === estudianteAgregar
      ))
  const aplicarAgregarAmbos =
    agregarReplicable && agregarAmbos && Boolean(estudianteAgregar)

  // Mover: replicable si el estudiante está en este mismo grupo en el otro hemi.
  const miembroMover = grupo.miembros.find(
    m => m.usuarioId === modoMover?.usuarioId
  )
  const miembroMoverOtroHemi = (grupo.miembrosOtroHemi ?? []).find(
    m => m.usuarioId === modoMover?.usuarioId
  )
  const moverReplicable = Boolean(otroHemi && miembroMoverOtroHemi)
  const aplicarMoverAmbos = moverReplicable && moverAmbos
  const requiereNuevoLider =
    miembroMover?.lider === true ||
    (aplicarMoverAmbos && miembroMoverOtroHemi?.lider === true)
  const mueveEvaluador =
    miembroMover?.rolGrupo === 'evaluador' ||
    (aplicarMoverAmbos && miembroMoverOtroHemi?.rolGrupo === 'evaluador')
  // Si se aplica en ambos, el reemplazo debe estar en el grupo en ambos hemis.
  const miembrosOrigenDisponibles = grupo.miembros.filter(
    m =>
      m.usuarioId !== modoMover?.usuarioId &&
      (!aplicarMoverAmbos ||
        (grupo.miembrosOtroHemi ?? []).some(o => o.usuarioId === m.usuarioId))
  )

  async function handleGuardarTemas() {
    setGuardandoTema(true)
    try {
      await Promise.all(
        hemisemestres.map(h =>
          temas[h.id] !== undefined
            ? actualizarTemaGrupo(grupo.id, h.id, temas[h.id])
            : Promise.resolve()
        )
      )
      onCerrarEditar()
      onTemaGuardado()
      notificar.exito('Temas del grupo guardados.')
    } catch (e) {
      onError(e.message)
      notificar.error(e)
    } finally {
      setGuardandoTema(false)
    }
  }

  async function handleGuardarRoles() {
    setGuardandoRoles(true)
    setErrorRoles('')
    try {
      await actualizarRolesGrupo(
        grupo.id,
        aplicarRolesAmbos ? [hemiActual, otroHemi] : [hemiActual],
        grupo.miembros.map(m => ({
          usuarioId: m.usuarioId,
          rolGrupo: roles[m.usuarioId]?.rolGrupo ?? m.rolGrupo,
          lider: roles[m.usuarioId]?.lider ?? m.lider
        }))
      )
      onCerrarEditarRoles()
      onTemaGuardado()
      notificar.exito(
        aplicarRolesAmbos || !otroHemi
          ? 'Roles del grupo actualizados.'
          : `Roles del grupo actualizados solo en ${nombreHemiActual}.`
      )
    } catch (e) {
      setErrorRoles(e.message)
      notificar.error(e)
    } finally {
      setGuardandoRoles(false)
    }
  }

  async function handleAgregar() {
    if (!estudianteAgregar) {
      const mensaje = 'Selecciona un estudiante.'
      setErrorAgregar(mensaje)
      notificar.aviso(mensaje)
      return
    }
    setGuardandoAgregar(true)
    setErrorAgregar('')
    try {
      await onAgregar(estudianteAgregar, rolAgregar, aplicarAgregarAmbos)
    } catch (e) {
      setErrorAgregar(e.message)
      notificar.error(e)
    } finally {
      setGuardandoAgregar(false)
    }
  }

  async function handleDeshacer() {
    setGuardandoDeshacer(true)
    try {
      await onDeshacer()
      notificar.exito(`Grupo ${grupo.numero} deshecho correctamente.`)
    } catch (e) {
      notificar.error(e)
    } finally {
      setGuardandoDeshacer(false)
      setConfirmandoDeshacer(false)
    }
  }

  const gruposDestino = grupos.filter(g => g.id !== grupo.id)
  const grupoDestinoSeleccionado = gruposDestino.find(
    g => g.id === grupoDestino
  )
  // Validación del destino en cada hemisemestre afectado.
  const miembrosDestinoPorHemi = grupoDestinoSeleccionado
    ? [
        { etiqueta: nombreHemiActual, miembros: grupoDestinoSeleccionado.miembros },
        ...(aplicarMoverAmbos
          ? [
              {
                etiqueta: nombreOtroHemi,
                miembros: grupoDestinoSeleccionado.miembrosOtroHemi ?? []
              }
            ]
          : [])
      ]
    : []
  const destinoConVariosEvaluadores = miembrosDestinoPorHemi.find(
    d =>
      d.miembros.filter(m => m.rolGrupo === 'evaluador').length +
        (rolDestino === 'evaluador' ? 1 : 0) >
      1
  )
  const destinoSinLiderUnico = miembrosDestinoPorHemi.find(
    d => d.miembros.filter(m => m.lider).length !== 1
  )
  const sufijoDestino = d =>
    aplicarMoverAmbos && d ? ` (${d.etiqueta})` : ''

  function confirmarMovimiento() {
    if (!grupoDestino) {
      setErrorMovimiento('Selecciona un grupo destino.')
      return
    }
    if (requiereNuevoLider && !nuevoLiderOrigenId) {
      setErrorMovimiento('Selecciona el nuevo líder del grupo de origen.')
      return
    }
    if (destinoSinLiderUnico) {
      setErrorMovimiento(
        `El grupo destino debe tener exactamente un líder${sufijoDestino(destinoSinLiderUnico)}.`
      )
      return
    }
    if (destinoConVariosEvaluadores) {
      setErrorMovimiento(
        `El grupo destino solo puede tener un evaluador${sufijoDestino(destinoConVariosEvaluadores)}.`
      )
      return
    }

    setErrorMovimiento('')
    onMoverA(
      grupoDestino,
      rolDestino,
      nuevoLiderOrigenId,
      nuevoEvaluadorOrigenId,
      aplicarMoverAmbos
    )
  }

  return (
    <div className="bg-white dark:bg-slate-800 border border-black/[0.11] dark:border-white/10 rounded-DEFAULT shadow-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-bold text-sice-green dark:text-emerald-300">
            Grupo {grupo.numero}
          </p>
          {otroHemi && !grupo.sincronizado && (
            <span
              className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sice-amber-soft text-sice-amber dark:text-amber-200"
              title={`Integrantes, roles o líder difieren entre ${nombreHemiActual} y ${nombreOtroHemi}`}
            >
              Distinto en {nombreOtroHemi}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {modoEdicion && estudiantesDisponibles.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={onIniciarAgregar}
            >
              <PersonAddIcon className="w-4 h-4" /> Añadir
            </Button>
          )}

          {modoEdicion && (
            <>
              {!catalogoFijo && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full sm:w-auto"
                    onClick={onEditarTema}
                  >
                    <EditIcon className="w-4 h-4" /> Editar temas
                  </Button>

                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full sm:w-auto"
                    onClick={() => setConfirmandoDeshacer(true)}
                  >
                    <DeleteIcon className="w-4 h-4" /> Deshacer
                  </Button>
                </>
              )}

              <Button
                size="sm"
                variant="ghost"
                className="w-full sm:w-auto"
                onClick={onEditarRoles}
              >
                <EditIcon className="w-4 h-4" /> Editar roles
              </Button>
            </>
          )}
        </div>
      </div>

      {confirmandoDeshacer && (
        <div className="mb-4 p-3 bg-sice-red-soft rounded-sm border border-sice-red/25">
          <p className="text-sm font-semibold text-sice-red mb-1">
            ¿Deshacer el Grupo {grupo.numero}?
          </p>
          <p className="text-xs text-ink-mid leading-relaxed">
            El grupo se elimina en todos los hemisemestres. Sus estudiantes
            volverán a la lista de estudiantes sin grupo y se eliminarán sus
            temas, calificaciones y coevaluaciones asociadas.
          </p>
          <div className="flex gap-2 mt-3 justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmandoDeshacer(false)}
              disabled={guardandoDeshacer}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={handleDeshacer}
              disabled={guardandoDeshacer}
            >
              {guardandoDeshacer ? (
                <>
                  <Spinner className="w-4 h-4" /> Deshaciendo…
                </>
              ) : (
                <>
                  <DeleteIcon className="w-4 h-4" /> Confirmar
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {modoAgregar && (
        <div className="mb-4 p-3 bg-gold-soft rounded-sm border border-gold/40">
          <p className="text-xs font-semibold text-ink-mid mb-3">
            Añadir estudiante al grupo en {nombreHemiActual}
          </p>
          {errorAgregar && <Aviso variant="red">{errorAgregar}</Aviso>}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="text-xs text-ink-soft block mb-1">
                Estudiante
              </label>
              <Select
                value={estudianteAgregar}
                onChange={e => {
                  setEstudianteAgregar(e.target.value)
                  setErrorAgregar('')
                }}
              >
                <option value="">— Seleccionar —</option>
                {estudiantesDisponibles.map(est => (
                  <option key={est.usuarioId} value={est.usuarioId}>
                    {est.nombre}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:w-36">
              <label className="text-xs text-ink-soft block mb-1">Rol</label>
              <Select
                value={rolAgregar}
                onChange={e => setRolAgregar(e.target.value)}
              >
                <option value="expositor">Expositor</option>
                <option value="evaluador">Evaluador</option>
              </Select>
            </div>
            <div className="flex gap-2 sm:pb-0">
              <Button
                size="sm"
                variant="outline"
                onClick={onCerrarAgregar}
                disabled={guardandoAgregar}
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleAgregar}
                disabled={guardandoAgregar || !estudianteAgregar}
              >
                {guardandoAgregar ? (
                  <>
                    <Spinner className="w-4 h-4" /> Añadiendo…
                  </>
                ) : (
                  <>
                    <PersonAddIcon className="w-4 h-4" /> Añadir
                  </>
                )}
              </Button>
            </div>
          </div>
          <CheckOtroHemi
            otroHemi={otroHemi}
            checked={agregarAmbos}
            onChange={setAgregarAmbos}
            disponible={agregarReplicable}
            motivo={`El estudiante ya tiene grupo en ${nombreOtroHemi}; solo se añadirá en ${nombreHemiActual}.`}
          />
        </div>
      )}

      {/* Edición de temas */}
      {modoEditar && (
        <div className="mb-4 p-3 bg-surface rounded-sm border border-black/10">
          <p className="text-xs font-semibold text-ink-mid mb-3">
            Temas por hemisemestre
          </p>
          <div className="flex flex-col gap-3">
            {hemisemestres.map((h, idx) => (
              <div key={h.id}>
                <label className="text-xs text-ink-soft block mb-1">
                  {h.orden === 1 ? 'Hemi 1' : 'Hemi 2'} — {h.nombre}
                </label>
                <Input
                  value={temas[h.id] ?? ''}
                  onChange={e =>
                    setTemas(prev => ({ ...prev, [h.id]: e.target.value }))
                  }
                  placeholder="Tema de este hemisemestre"
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="outline" onClick={onCerrarEditar}>
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={handleGuardarTemas}
              disabled={guardandoTema}
            >
              {guardandoTema ? (
                'Guardando…'
              ) : (
                <>
                  <SaveIcon className="w-4 h-4" /> Guardar temas
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {modoEditarRoles && (
        <div className="mb-4 p-3 bg-surface rounded-sm border border-black/10">
          <p className="text-xs font-semibold text-ink-mid mb-3">
            Roles y líder del grupo en {nombreHemiActual}
          </p>
          {errorRoles && <Aviso variant="red">{errorRoles}</Aviso>}
          <div className="flex flex-col gap-1.5">
            {grupo.miembros.map(m => (
              <div
                key={m.usuarioId}
                className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-700 rounded-sm px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-sm font-medium break-words">
                  {m.nombre}
                </span>
                <Select
                  value={roles[m.usuarioId]?.rolGrupo ?? m.rolGrupo}
                  onChange={e =>
                    setRoles(prev => ({
                      ...prev,
                      [m.usuarioId]: {
                        ...prev[m.usuarioId],
                        rolGrupo: e.target.value
                      }
                    }))
                  }
                  className="w-32 text-xs py-1.5"
                >
                  <option value="expositor">Expositor</option>
                  <option value="evaluador">Evaluador</option>
                </Select>
                <label className="flex items-center gap-1 text-xs text-ink-mid">
                  <input
                    type="radio"
                    name={`lider-${grupo.id}`}
                    checked={roles[m.usuarioId]?.lider ?? m.lider}
                    onChange={() =>
                      setRoles(prev => ({
                        ...prev,
                        ...Object.fromEntries(
                          grupo.miembros.map(miembro => [
                            miembro.usuarioId,
                            {
                              ...prev[miembro.usuarioId],
                              lider: miembro.usuarioId === m.usuarioId
                            }
                          ])
                        )
                      }))
                    }
                    className="accent-gold"
                  />
                  Líder
                </label>
              </div>
            ))}
          </div>
          <CheckOtroHemi
            otroHemi={otroHemi}
            checked={rolesAmbos}
            onChange={setRolesAmbos}
            disponible={rolesReplicables}
            motivo={`Los integrantes del grupo son distintos en ${nombreOtroHemi}; los roles solo se cambiarán en ${nombreHemiActual}.`}
          />
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="outline" onClick={onCerrarEditarRoles}>
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={handleGuardarRoles}
              disabled={guardandoRoles}
            >
              {guardandoRoles ? 'Guardando…' : 'Guardar roles'}
            </Button>
          </div>
        </div>
      )}

      {/* Lista de miembros */}
      <ul className="flex flex-col gap-1.5">
        {grupo.miembros.map(m => (
          <li
            key={m.usuarioId}
            className="flex flex-wrap items-center gap-2 bg-surface rounded-sm px-3 py-2"
          >
            <span className="w-full min-w-0 text-sm font-medium break-words sm:w-auto sm:flex-1 sm:min-w-[140px]">
              {m.nombre}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Badge variant={m.rolGrupo === 'evaluador' ? 'ok' : 'info'}>
                {m.rolGrupo === 'evaluador' ? 'Evaluador' : 'Expositor'}
              </Badge>
              {m.lider && <Badge variant="pending">Líder</Badge>}
              {modoEdicion && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onIniciarMover(m.usuarioId)}
                >
                  <SwapHorizIcon className="w-4 h-4" /> Mover
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Panel de mover integrante */}
      {modoMover && (
        <div className="mt-3 p-3 bg-surface rounded-sm border border-black/10">
          <p className="text-xs font-semibold text-ink-mid mb-3">
            Mover <strong>{miembroMover?.nombre}</strong> a otro grupo en{' '}
            {nombreHemiActual}
          </p>
          {errorMovimiento && <Aviso variant="red">{errorMovimiento}</Aviso>}
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-ink-soft block mb-1">
                Grupo destino
              </label>
              <Select
                value={grupoDestino}
                onChange={e => {
                  setGrupoDestino(e.target.value)
                  setErrorMovimiento('')
                }}
              >
                <option value="">— Seleccionar —</option>
                {gruposDestino.map(gd => (
                  <option key={gd.id} value={gd.id}>
                    Grupo {gd.numero}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="text-xs text-ink-soft block mb-1">
                Nuevo rol
              </label>
              <Select
                value={rolDestino}
                onChange={e => {
                  setRolDestino(e.target.value)
                  setErrorMovimiento('')
                }}
              >
                <option value="expositor">Expositor</option>
                <option value="evaluador">Evaluador</option>
              </Select>
            </div>
            {requiereNuevoLider && (
              <div>
                <label className="text-xs text-ink-soft block mb-1">
                  Nuevo líder del grupo de origen
                </label>
                <Select
                  value={nuevoLiderOrigenId}
                  onChange={e => {
                    setNuevoLiderOrigenId(e.target.value)
                    setErrorMovimiento('')
                  }}
                >
                  <option value="">— Seleccionar —</option>
                  {miembrosOrigenDisponibles.map(m => (
                    <option key={m.usuarioId} value={m.usuarioId}>
                      {m.nombre}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {mueveEvaluador && (
              <div>
                <label className="text-xs text-ink-soft block mb-1">
                  Nuevo evaluador del grupo de origen
                </label>
                <Select
                  value={nuevoEvaluadorOrigenId}
                  onChange={e => {
                    setNuevoEvaluadorOrigenId(e.target.value)
                    setErrorMovimiento('')
                  }}
                >
                  <option value="">— Ninguno —</option>
                  {miembrosOrigenDisponibles.map(m => (
                    <option key={m.usuarioId} value={m.usuarioId}>
                      {m.nombre}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-ink-soft mt-1">
                  Es opcional; los grupos no están obligados a tener un
                  evaluador.
                </p>
              </div>
            )}
            {grupoDestino && destinoConVariosEvaluadores && (
              <p className="text-xs text-red-700">
                El grupo destino solo puede tener un evaluador
                {sufijoDestino(destinoConVariosEvaluadores)}.
              </p>
            )}
          </div>
          <CheckOtroHemi
            otroHemi={otroHemi}
            checked={moverAmbos}
            onChange={valor => {
              setMoverAmbos(valor)
              setNuevoLiderOrigenId('')
              setNuevoEvaluadorOrigenId('')
              setErrorMovimiento('')
            }}
            disponible={moverReplicable}
            motivo={`En ${nombreOtroHemi} el estudiante pertenece a otro grupo; solo se moverá en ${nombreHemiActual}.`}
          />
          <div className="flex gap-2 mt-3 justify-end">
            <Button size="sm" variant="outline" onClick={onCancelarMover}>
              Cancelar
            </Button>
            <Button size="sm" onClick={confirmarMovimiento}>
              Confirmar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
