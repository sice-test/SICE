import { supabase } from './supabase.js'

// ---- Periodos ----

export async function obtenerPeriodos() {
  const { data, error } = await supabase
    .from('periodos')
    .select('id, nombre')
    .order('nombre', { ascending: false })
  if (error) throw error
  return data
}

export async function crearPeriodo(nombre) {
  const { data, error } = await supabase
    .from('periodos')
    .insert({ nombre })
    .select('id, nombre')
    .single()
  if (error) throw error
  return data
}

export async function eliminarPeriodo(periodoId) {
  const { error } = await supabase.from('periodos').delete().eq('id', periodoId)
  if (error) throw error
}

// ---- Materias ----

export async function obtenerMaterias() {
  const { data, error } = await supabase
    .from('materias')
    .select('id, nombre, semestre')
    .order('semestre')
  if (error) throw error
  return data
}

export async function obtenerParalelosProfesor(profesorId) {
  const { data, error } = await supabase
    .from('paralelos')
    .select('id, codigo, creado_en, materias(nombre), periodos(nombre)')
    .eq('profesor_id', profesorId)
    .order('creado_en', { ascending: false })
  if (error) throw error
  return data.map(p => ({
    id: p.id,
    codigo: p.codigo,
    materiaNombre: p.materias?.nombre ?? '—',
    periodoNombre: p.periodos?.nombre ?? '—'
  }))
}

// ---- Paralelos ----

// Crea el paralelo si no existe. El trigger de BD crea automáticamente
// los 2 hemisemestres y la configuracion_notas (70/30).
export async function upsertParalelo({
  materiaId,
  periodoId,
  codigo,
  profesorId
}) {
  const { data: existente } = await supabase
    .from('paralelos')
    .select('id')
    .eq('materia_id', materiaId)
    .eq('periodo_id', periodoId)
    .eq('codigo', codigo)
    .maybeSingle()
  if (existente) return existente

  const { data, error } = await supabase
    .from('paralelos')
    .insert({
      materia_id: materiaId,
      periodo_id: periodoId,
      codigo,
      profesor_id: profesorId
    })
    .select('id')
    .single()
  if (error) throw error
  return data
}

export async function eliminarParalelo(paraleloId) {
  const { error } = await supabase
    .from('paralelos')
    .delete()
    .eq('id', paraleloId)
  if (error) throw error
}

// ---- Hemisemestres ----
// Siempre 2 por paralelo, creados por trigger. Esta función solo los lee.

export async function obtenerHemisemestres(paraleloId) {
  const { data, error } = await supabase
    .from('hemisemestres')
    .select('id, nombre, orden')
    .eq('paralelo_id', paraleloId)
    .order('orden')
  if (error) throw error
  return data
}

// ---- Grupos ----

export async function obtenerEstadoAsignacion(paraleloId) {
  const { data, error } = await supabase
    .from('paralelos')
    .select('estado_asignacion')
    .eq('id', paraleloId)
    .single()
  if (error) throw error
  return data.estado_asignacion
}

// hemisemestreId = null aplica la asignación en ambos hemisemestres.
export async function asignarEstudianteGrupo({
  paraleloId,
  grupoId,
  rolGrupo,
  lider,
  hemisemestreId = null
}) {
  const { error } = await supabase.rpc('asignar_estudiante_grupo', {
    p_paralelo_id: paraleloId,
    p_grupo_id: grupoId,
    p_rol_grupo: rolGrupo,
    p_lider: lider,
    p_hemisemestre_id: hemisemestreId
  })
  if (error) throw error
}

export async function finalizarAsignacion(paraleloId) {
  const { error } = await supabase.rpc('finalizar_asignacion', {
    p_paralelo_id: paraleloId
  })
  if (error) throw error
}

export async function reabrirAsignacion(paraleloId) {
  const { error } = await supabase.rpc('reabrir_asignacion', {
    p_paralelo_id: paraleloId
  })
  if (error) throw error
}

export function etiquetaHemisemestre(hemisemestre) {
  return hemisemestre?.orden === 1 ? 'Hemi 1' : 'Hemi 2'
}

// Sufijo " (Hemi N)" para mensajes cuando la operación abarca varios hemis.
function sufijoHemi(hemisemestre, varios) {
  return varios ? ` (${etiquetaHemisemestre(hemisemestre)})` : ''
}

function validarHemisemestres(hemisemestres) {
  if (!Array.isArray(hemisemestres) || hemisemestres.length === 0) {
    throw new Error('Selecciona al menos un hemisemestre.')
  }
}

function validarMiembrosGrupo(miembros, sufijo = '') {
  const cantidadLideres = miembros.filter(m => m.lider).length
  if (cantidadLideres !== 1) {
    throw new Error(`Todos los grupos deben tener un líder${sufijo}.`)
  }
  const cantidadEvaluadores = miembros.filter(
    m => m.rolGrupo === 'evaluador'
  ).length
  if (cantidadEvaluadores > 1) {
    throw new Error(`Cada grupo puede tener un solo evaluador${sufijo}.`)
  }
}

// Grupos con tema y miembros de UN hemisemestre.
export async function obtenerGruposConDetalle(paraleloId, hemisemestreId) {
  const { data, error } = await supabase
    .from('grupos')
    .select(
      `
      id, numero, max_integrantes,
      grupo_temas!inner ( id, tema, hemisemestre_id, coevaluacion_habilitada ),
      grupo_miembros ( usuario_id, rol_grupo, lider, hemisemestre_id, coevaluacion_bloqueada )
    `
    )
    .eq('paralelo_id', paraleloId)
    .eq('grupo_temas.hemisemestre_id', hemisemestreId)
    .eq('grupo_miembros.hemisemestre_id', hemisemestreId)
    .order('numero')
  if (error) throw error

  const userIds = [
    ...new Set(
      (data ?? []).flatMap(g => (g.grupo_miembros ?? []).map(m => m.usuario_id))
    )
  ]

  const { data: usuarios, error: errUsuarios } = userIds.length
    ? await supabase
        .from('usuarios')
        .select('id, nombre_completo, email')
        .in('id', userIds)
    : { data: [], error: null }
  if (errUsuarios) throw errUsuarios

  const mapUsuarios = new Map((usuarios ?? []).map(u => [u.id, u]))

  const gruposUnicos = new Map((data ?? []).map(g => [g.id, g]))
  return [...gruposUnicos.values()].map(g => ({
    id: g.id,
    numero: g.numero,
    maxIntegrantes: g.max_integrantes,
    grupoTemaId: g.grupo_temas[0]?.id,
    tema: g.grupo_temas[0]?.tema ?? '(sin tema)',
    coevaluacionHabilitada: Boolean(g.grupo_temas[0]?.coevaluacion_habilitada),
    miembros: [
      ...new Map(
        (g.grupo_miembros ?? []).map(m => [m.usuario_id, m])
      ).values()
    ].map(m => {
      const usuario = mapUsuarios.get(m.usuario_id)
      return {
        usuarioId: m.usuario_id,
        nombre: usuario?.nombre_completo ?? '(sin nombre)',
        rolGrupo: m.rol_grupo,
        lider: m.lider,
        coevaluacionBloqueada: Boolean(m.coevaluacion_bloqueada)
      }
    })
  }))
}

// Integrantes de un grupo que pueden recibir coevaluación (excluye a los
// estudiantes bloqueados individualmente por el docente).
export function miembrosCoevaluables(grupo) {
  return (grupo?.miembros ?? []).filter(m => !m.coevaluacionBloqueada)
}

// Bloquea o desbloquea la coevaluación de un estudiante en un hemisemestre.
export async function actualizarBloqueoCoevaluacionEstudiante({
  grupoId,
  usuarioId,
  hemisemestreId,
  bloqueada
}) {
  const { data, error } = await supabase
    .from('grupo_miembros')
    .update({ coevaluacion_bloqueada: Boolean(bloqueada) })
    .eq('grupo_id', grupoId)
    .eq('usuario_id', usuarioId)
    .eq('hemisemestre_id', hemisemestreId)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error(
      'No se pudo actualizar la coevaluación del estudiante. Asegúrate de haber ejecutado la migración de bloqueo individual en Supabase.'
    )
  }
}

// Hemisemestres (ids) en los que la coevaluación del estudiante está bloqueada.
export async function obtenerBloqueosCoevaluacionEstudiante(
  usuarioId,
  hemisemestreIds
) {
  if (!usuarioId || hemisemestreIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from('grupo_miembros')
    .select('hemisemestre_id, coevaluacion_bloqueada')
    .eq('usuario_id', usuarioId)
    .in('hemisemestre_id', hemisemestreIds)
  if (error) throw error
  return new Set(
    (data ?? [])
      .filter(fila => fila.coevaluacion_bloqueada)
      .map(fila => fila.hemisemestre_id)
  )
}

// Para el builder del Admin: grupos con los miembros de cada hemisemestre.
// Devuelve `miembrosPorHemi` = { [hemisemestreId]: miembros[] }.
export async function obtenerGruposBase(paraleloId) {
  const { data, error } = await supabase
    .from('grupos')
    .select(
      `
      id, numero, max_integrantes,
      grupo_miembros ( usuario_id, rol_grupo, lider, hemisemestre_id )
    `
    )
    .eq('paralelo_id', paraleloId)
    .order('numero')
  if (error) throw error

  const userIds = [
    ...new Set(
      (data ?? []).flatMap(g => (g.grupo_miembros ?? []).map(m => m.usuario_id))
    )
  ]

  const { data: usuarios, error: errUsuarios } = userIds.length
    ? await supabase
        .from('usuarios')
        .select('id, nombre_completo, email')
        .in('id', userIds)
    : { data: [], error: null }
  if (errUsuarios) throw errUsuarios

  const mapUsuarios = new Map((usuarios ?? []).map(u => [u.id, u]))

  const gruposUnicos = new Map((data ?? []).map(g => [g.id, g]))
  return [...gruposUnicos.values()].map(g => {
    const miembrosPorHemi = {}
    ;(g.grupo_miembros ?? []).forEach(m => {
      const lista = (miembrosPorHemi[m.hemisemestre_id] ??= [])
      if (lista.some(x => x.usuarioId === m.usuario_id)) return
      const usuario = mapUsuarios.get(m.usuario_id)
      lista.push({
        usuarioId: m.usuario_id,
        nombre: usuario?.nombre_completo ?? '(sin nombre)',
        email: usuario?.email ?? '',
        rolGrupo: m.rol_grupo,
        lider: m.lider
      })
    })
    return {
      id: g.id,
      numero: g.numero,
      maxIntegrantes: g.max_integrantes,
      miembrosPorHemi
    }
  })
}

// Crea un grupo con sus miembros y un tema independiente por hemisemestre.
// Los miembros se crean en `hemisemestresMiembros` (por defecto, en todos).
export async function crearGrupo({
  paraleloId,
  numero,
  maxIntegrantes,
  temas,
  hemisemestres,
  hemisemestresMiembros = null,
  miembros
}) {
  validarMiembrosGrupo(miembros)

  const { data: grupo, error } = await supabase.rpc('crear_grupo_admin', {
    p_paralelo_id: paraleloId,
    p_numero: numero,
    p_max_integrantes: maxIntegrantes,
    p_temas: temas ?? {},
    p_hemisemestres: hemisemestres ?? [],
    p_miembros: miembros ?? [],
    p_hemisemestres_miembros: hemisemestresMiembros
      ? hemisemestresMiembros.map(h => ({ id: h.id }))
      : null
  })
  if (error) throw error

  return grupo
}

// Elimina un grupo y devuelve sus estudiantes a la lista sin grupo.
// Las relaciones dependientes (temas, miembros y calificaciones) se eliminan
// mediante las reglas on delete cascade del esquema.
export async function eliminarGrupo(grupoId) {
  const { error } = await supabase.from('grupos').delete().eq('id', grupoId)
  if (error) throw error
}

// Actualiza el tema de un grupo en UN hemisemestre específico.
// Actualiza el estado de coevaluación de un grupo en un hemisemestre específico.
// Guarda el estado de coevaluación de múltiples grupos a la vez.
export async function guardarEstadosCoevaluacion(grupos, hemisemestreId) {
  if (!grupos || grupos.length === 0) return

  const payload = grupos.map(g => ({
    grupo_id: g.id,
    habilitada: Boolean(g.coevaluacionHabilitada)
  }))

  // 1. Intentar primero con la función RPC Security Definer (garantiza bypass de RLS de catálogo fijo)
  const { error: rpcError } = await supabase.rpc(
    'actualizar_coevaluacion_grupos',
    {
      p_cambios: payload,
      p_hemisemestre_id: hemisemestreId
    }
  )

  if (!rpcError) return

  // 2. Fallback a update directo con verificación explícita de filas modificadas
  const promesas = grupos.map(async g => {
    let query = supabase
      .from('grupo_temas')
      .update({ coevaluacion_habilitada: Boolean(g.coevaluacionHabilitada) })

    if (g.grupoTemaId) {
      query = query.eq('id', g.grupoTemaId)
    } else {
      query = query
        .eq('grupo_id', g.id)
        .eq('hemisemestre_id', hemisemestreId)
    }

    const { data, error } = await query.select()
    if (error) throw error
    if (!data || data.length === 0) {
      throw new Error(
        `No se pudo actualizar el Grupo ${g.numero}. Asegúrate de haber ejecutado el script SQL de migración en Supabase.`
      )
    }
  })

  await Promise.all(promesas)
}

// Actualiza el estado de coevaluación de un grupo en un hemisemestre específico.
export async function actualizarEstadoCoevaluacionGrupo(
  grupoId,
  hemisemestreId,
  habilitada,
  grupoTemaId
) {
  const { error: rpcError } = await supabase.rpc(
    'actualizar_coevaluacion_grupos',
    {
      p_cambios: [{ grupo_id: grupoId, habilitada: Boolean(habilitada) }],
      p_hemisemestre_id: hemisemestreId
    }
  )

  if (!rpcError) return

  let query = supabase
    .from('grupo_temas')
    .update({ coevaluacion_habilitada: Boolean(habilitada) })

  if (grupoTemaId) {
    query = query.eq('id', grupoTemaId)
  } else {
    query = query
      .eq('grupo_id', grupoId)
      .eq('hemisemestre_id', hemisemestreId)
  }

  const { data, error } = await query.select()
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error(
      'No se pudo actualizar el grupo en la base de datos. Asegúrate de haber ejecutado el script SQL de migración en Supabase.'
    )
  }
}

// Actualiza el estado de coevaluación para un conjunto de grupos.
export async function actualizarEstadoCoevaluacionTodos(
  grupos,
  hemisemestreId,
  habilitada
) {
  if (!grupos || grupos.length === 0) return

  const payload = grupos.map(item => ({
    grupo_id: typeof item === 'object' ? item.id : item,
    habilitada: Boolean(habilitada)
  }))

  const { error: rpcError } = await supabase.rpc(
    'actualizar_coevaluacion_grupos',
    {
      p_cambios: payload,
      p_hemisemestre_id: hemisemestreId
    }
  )

  if (!rpcError) return

  const promesas = grupos.map(async item => {
    const temaId = typeof item === 'object' ? item.grupoTemaId : null
    const gId = typeof item === 'object' ? item.id : item

    let query = supabase
      .from('grupo_temas')
      .update({ coevaluacion_habilitada: Boolean(habilitada) })

    if (temaId) {
      query = query.eq('id', temaId)
    } else {
      query = query
        .eq('grupo_id', gId)
        .eq('hemisemestre_id', hemisemestreId)
    }

    const { data, error } = await query.select()
    if (error) throw error
    if (!data || data.length === 0) {
      throw new Error(
        'No se pudieron actualizar los grupos en la base de datos. Asegúrate de haber ejecutado el script SQL de migración en Supabase.'
      )
    }
  })

  await Promise.all(promesas)
}

// Consulta si la coevaluación para un grupo está habilitada en un hemisemestre.
export async function obtenerEstadoCoevaluacionGrupo(grupoId, hemisemestreId) {
  const { data, error } = await supabase
    .from('grupo_temas')
    .select('coevaluacion_habilitada')
    .eq('grupo_id', grupoId)
    .eq('hemisemestre_id', hemisemestreId)
    .maybeSingle()

  if (error) throw error
  return Boolean(data?.coevaluacion_habilitada)
}

// ---- Autoevaluación del estudiante ----

export async function obtenerEstadoAutoevaluacion(paraleloId, hemisemestreId) {
  const { data, error } = await supabase
    .from('configuracion_autoevaluacion')
    .select('habilitada')
    .eq('paralelo_id', paraleloId)
    .eq('hemisemestre_id', hemisemestreId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.habilitada)
}

export async function configurarAutoevaluacion(
  paraleloId,
  hemisemestreId,
  habilitada
) {
  const { error } = await supabase.rpc('configurar_autoevaluacion', {
    p_paralelo_id: paraleloId,
    p_hemisemestre_id: hemisemestreId,
    p_habilitada: Boolean(habilitada)
  })
  if (error) throw error
}

export async function obtenerAutoevaluaciones(
  estudianteId,
  hemisemestreId,
  rubricaIds
) {
  const { data, error } = await supabase
    .from('autoevaluaciones')
    .select('id, rubrica_id, respuestas, puntaje, actualizado_en')
    .eq('estudiante_id', estudianteId)
    .eq('hemisemestre_id', hemisemestreId)
    .in('rubrica_id', rubricaIds)
  if (error) throw error
  return data ?? []
}

export async function obtenerMapaAutoevaluaciones(
  estudianteIds,
  hemisemestreId,
  rubricaIds
) {
  const mapa = new Map()
  if (estudianteIds.length === 0 || rubricaIds.length === 0) return mapa

  const { data, error } = await supabase
    .from('autoevaluaciones')
    .select('estudiante_id, rubrica_id, puntaje')
    .eq('hemisemestre_id', hemisemestreId)
    .in('estudiante_id', estudianteIds)
    .in('rubrica_id', rubricaIds)
  if (error) throw error

  data.forEach(fila => {
    const filas = mapa.get(fila.estudiante_id) ?? []
    filas.push(fila)
    mapa.set(fila.estudiante_id, filas)
  })
  return mapa
}

export async function guardarAutoevaluaciones(
  estudianteId,
  hemisemestreId,
  evaluaciones
) {
  const filas = evaluaciones.map(evaluacion => ({
    estudiante_id: estudianteId,
    hemisemestre_id: hemisemestreId,
    rubrica_id: evaluacion.rubricaId,
    respuestas: evaluacion.respuestas,
    puntaje: evaluacion.puntaje,
    actualizado_en: new Date().toISOString()
  }))
  const { error } = await supabase.from('autoevaluaciones').upsert(filas, {
    onConflict: 'estudiante_id,hemisemestre_id,rubrica_id'
  })
  if (error) throw error
}

export async function actualizarTemaGrupo(grupoId, hemisemestreId, tema) {
  const { error } = await supabase
    .from('grupo_temas')
    .upsert(
      { grupo_id: grupoId, hemisemestre_id: hemisemestreId, tema },
      { onConflict: 'grupo_id,hemisemestre_id' }
    )
  if (error) throw error
}

// Actualiza roles y líder de un grupo en los hemisemestres indicados.
// Si son varios, los integrantes deben ser los mismos en todos ellos.
export async function actualizarRolesGrupo(grupoId, hemisemestres, miembros) {
  validarHemisemestres(hemisemestres)
  validarMiembrosGrupo(miembros)
  const hemiIds = hemisemestres.map(h => h.id)
  const varios = hemiIds.length > 1

  const { data: actuales, error: errActuales } = await supabase
    .from('grupo_miembros')
    .select('usuario_id, hemisemestre_id')
    .eq('grupo_id', grupoId)
    .in('hemisemestre_id', hemiIds)
  if (errActuales) throw errActuales

  const idsEsperados = new Set(miembros.map(m => m.usuarioId))
  hemisemestres.forEach(h => {
    const ids = new Set(
      actuales
        .filter(a => a.hemisemestre_id === h.id)
        .map(a => a.usuario_id)
    )
    const coinciden =
      ids.size === idsEsperados.size &&
      [...idsEsperados].every(id => ids.has(id))
    if (!coinciden) {
      throw new Error(
        `Los integrantes del grupo no coinciden${sufijoHemi(h, varios)}. Actualiza la página e inténtalo de nuevo.`
      )
    }
  })

  const { error: quitarLideresError } = await supabase
    .from('grupo_miembros')
    .update({ lider: false })
    .eq('grupo_id', grupoId)
    .in('hemisemestre_id', hemiIds)
  if (quitarLideresError) throw quitarLideresError

  await Promise.all(
    miembros.map(async miembro => {
      const { error } = await supabase
        .from('grupo_miembros')
        .update({ rol_grupo: miembro.rolGrupo, lider: miembro.lider })
        .eq('grupo_id', grupoId)
        .eq('usuario_id', miembro.usuarioId)
        .in('hemisemestre_id', hemiIds)
      if (error) throw error
    })
  )
}

// Mueve un integrante de un grupo a otro en los hemisemestres indicados,
// cambiando opcionalmente su rol. Se valida todo antes de escribir.
export async function moverIntegrante({
  usuarioId,
  grupoOrigenId,
  grupoDestinoId,
  rolGrupo,
  nuevoLiderOrigenId,
  nuevoEvaluadorOrigenId,
  hemisemestres
}) {
  validarHemisemestres(hemisemestres)
  if (grupoOrigenId === grupoDestinoId) {
    throw new Error(
      'El grupo de destino debe ser diferente al grupo de origen.'
    )
  }
  const hemiIds = hemisemestres.map(h => h.id)
  const varios = hemiIds.length > 1

  const { data: miembrosActuales, error: errConsulta } = await supabase
    .from('grupo_miembros')
    .select('grupo_id, usuario_id, rol_grupo, lider, hemisemestre_id')
    .in('grupo_id', [grupoOrigenId, grupoDestinoId])
    .in('hemisemestre_id', hemiIds)
  if (errConsulta) throw errConsulta

  const planes = hemisemestres.map(h => {
    const sufijo = sufijoHemi(h, varios)
    const enHemi = miembrosActuales.filter(m => m.hemisemestre_id === h.id)
    const miembro = enHemi.find(
      m => m.grupo_id === grupoOrigenId && m.usuario_id === usuarioId
    )
    if (!miembro) {
      throw new Error(`El integrante no pertenece al grupo de origen${sufijo}.`)
    }
    const restantesOrigen = enHemi.filter(
      m => m.grupo_id === grupoOrigenId && m.usuario_id !== usuarioId
    )

    const reemplazaLider = miembro.lider
    if (reemplazaLider && !nuevoLiderOrigenId) {
      throw new Error(
        `Selecciona el nuevo líder del grupo de origen antes de mover al líder actual${sufijo}.`
      )
    }
    if (
      reemplazaLider &&
      !restantesOrigen.some(m => m.usuario_id === nuevoLiderOrigenId)
    ) {
      throw new Error(
        `El nuevo líder debe pertenecer al grupo de origen${sufijo}.`
      )
    }

    const reemplazaEvaluador =
      miembro.rol_grupo === 'evaluador' && Boolean(nuevoEvaluadorOrigenId)
    if (
      reemplazaEvaluador &&
      !restantesOrigen.some(m => m.usuario_id === nuevoEvaluadorOrigenId)
    ) {
      throw new Error(
        `El nuevo evaluador debe pertenecer al grupo de origen${sufijo}.`
      )
    }

    const miembrosOrigen = restantesOrigen.map(m => ({
      lider: reemplazaLider ? m.usuario_id === nuevoLiderOrigenId : m.lider,
      rolGrupo:
        reemplazaEvaluador && m.usuario_id === nuevoEvaluadorOrigenId
          ? 'evaluador'
          : m.rol_grupo
    }))
    const miembrosDestino = enHemi
      .filter(m => m.grupo_id === grupoDestinoId)
      .map(m => ({ lider: m.lider, rolGrupo: m.rol_grupo }))
    miembrosDestino.push({ lider: false, rolGrupo })

    validarMiembrosGrupo(miembrosOrigen, sufijo)
    validarMiembrosGrupo(miembrosDestino, sufijo)

    return { hemisemestreId: h.id, reemplazaLider, reemplazaEvaluador }
  })

  for (const { hemisemestreId, reemplazaLider, reemplazaEvaluador } of planes) {
    // Quitar del grupo origen
    const { error: errDel } = await supabase
      .from('grupo_miembros')
      .delete()
      .eq('grupo_id', grupoOrigenId)
      .eq('usuario_id', usuarioId)
      .eq('hemisemestre_id', hemisemestreId)
    if (errDel) throw errDel

    // Persistir el reemplazo de líder del grupo origen.
    if (reemplazaLider) {
      const { error: errNuevoLider } = await supabase
        .from('grupo_miembros')
        .update({ lider: true })
        .eq('grupo_id', grupoOrigenId)
        .eq('usuario_id', nuevoLiderOrigenId)
        .eq('hemisemestre_id', hemisemestreId)
      if (errNuevoLider) throw errNuevoLider
    }

    // Persistir el reemplazo de evaluador del grupo origen.
    if (reemplazaEvaluador) {
      const { error: errNuevoEvaluador } = await supabase
        .from('grupo_miembros')
        .update({ rol_grupo: 'evaluador' })
        .eq('grupo_id', grupoOrigenId)
        .eq('usuario_id', nuevoEvaluadorOrigenId)
        .eq('hemisemestre_id', hemisemestreId)
      if (errNuevoEvaluador) throw errNuevoEvaluador
    }

    // Insertar en el grupo destino
    const { error: errIns } = await supabase.from('grupo_miembros').insert({
      grupo_id: grupoDestinoId,
      usuario_id: usuarioId,
      hemisemestre_id: hemisemestreId,
      rol_grupo: rolGrupo,
      lider: false
    })
    if (errIns) throw errIns
  }
}

// Añade un estudiante sin grupo a un grupo existente en los hemisemestres
// indicados.
export async function agregarIntegranteGrupo({
  grupoId,
  usuarioId,
  rolGrupo = 'expositor',
  hemisemestres
}) {
  validarHemisemestres(hemisemestres)
  const hemiIds = hemisemestres.map(h => h.id)
  const varios = hemiIds.length > 1

  const { data: miembrosActuales, error: errMiembros } = await supabase
    .from('grupo_miembros')
    .select('usuario_id, rol_grupo, lider, hemisemestre_id')
    .eq('grupo_id', grupoId)
    .in('hemisemestre_id', hemiIds)
  if (errMiembros) throw errMiembros

  hemisemestres.forEach(h => {
    const sufijo = sufijoHemi(h, varios)
    const enHemi = miembrosActuales.filter(m => m.hemisemestre_id === h.id)
    if (enHemi.some(m => m.usuario_id === usuarioId)) {
      throw new Error(`El estudiante ya pertenece a este grupo${sufijo}.`)
    }
    if (
      rolGrupo === 'evaluador' &&
      enHemi.some(m => m.rol_grupo === 'evaluador')
    ) {
      throw new Error(`Cada grupo puede tener un solo evaluador${sufijo}.`)
    }
  })

  const { error } = await supabase.from('grupo_miembros').insert(
    hemiIds.map(hemisemestreId => ({
      grupo_id: grupoId,
      usuario_id: usuarioId,
      hemisemestre_id: hemisemestreId,
      rol_grupo: rolGrupo,
      lider: false
    }))
  )
  if (error) throw error
}

// Estudiantes del paralelo sin grupo, por hemisemestre (para el builder).
// Devuelve Map hemisemestreId → estudiantes[].
export async function obtenerEstudiantesSinGrupo(paraleloId, hemisemestres) {
  const { data: matriculados, error: errMat } = await supabase
    .from('matriculas')
    .select(
      'usuario_id, usuarios!matriculas_usuario_id_fkey(nombre_completo, email)'
    )
    .eq('paralelo_id', paraleloId)
  if (errMat) throw errMat

  const { data: conGrupo, error: errG } = await supabase
    .from('grupo_miembros')
    .select('usuario_id, hemisemestre_id, grupos!inner(paralelo_id)')
    .eq('grupos.paralelo_id', paraleloId)
  if (errG) throw errG

  const conGrupoPorHemi = new Map(hemisemestres.map(h => [h.id, new Set()]))
  conGrupo.forEach(r =>
    conGrupoPorHemi.get(r.hemisemestre_id)?.add(r.usuario_id)
  )

  const matriculadosUnicos = [
    ...new Map(matriculados.map(m => [m.usuario_id, m])).values()
  ]
  return new Map(
    hemisemestres.map(h => [
      h.id,
      matriculadosUnicos
        .filter(m => !conGrupoPorHemi.get(h.id).has(m.usuario_id))
        .map(m => ({
          usuarioId: m.usuario_id,
          nombre: m.usuarios?.nombre_completo ?? '—',
          email: m.usuarios?.email ?? ''
        }))
    ])
  )
}

// ---- Matrículas ----

export async function matricularEstudiantes(paraleloId, usuarioIds) {
  const filas = usuarioIds.map(uid => ({
    paralelo_id: paraleloId,
    usuario_id: uid
  }))
  const { error } = await supabase.from('matriculas').upsert(filas, {
    onConflict: 'paralelo_id,usuario_id',
    ignoreDuplicates: true
  })
  if (error) {
    if (
      error.code === '23505' &&
      error.message?.includes('periodo académico')
    ) {
      throw new Error(
        'Uno o más estudiantes ya están matriculados en otra materia-paralelo de este periodo académico.'
      )
    }
    throw error
  }
}

// ---- Calificaciones del docente ----

export async function obtenerCalificacionDocente(
  estudianteId,
  hemisemestreId,
  rubricaId
) {
  const { data, error } = await supabase
    .from('calificaciones_docente')
    .select('id, respuestas, puntaje, comentario, actualizado_en')
    .eq('estudiante_id', estudianteId)
    .eq('hemisemestre_id', hemisemestreId)
    .eq('rubrica_id', rubricaId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function guardarCalificacionDocente({
  profesorId,
  estudianteId,
  grupoId,
  hemisemestreId,
  rubricaId,
  respuestas,
  puntaje,
  comentario
}) {
  const { error } = await supabase.from('calificaciones_docente').upsert(
    {
      profesor_id: profesorId,
      estudiante_id: estudianteId,
      grupo_id: grupoId,
      hemisemestre_id: hemisemestreId,
      rubrica_id: rubricaId,
      respuestas,
      puntaje,
      comentario: comentario ?? null,
      actualizado_en: new Date().toISOString()
    },
    { onConflict: 'estudiante_id,hemisemestre_id,rubrica_id' }
  )
  if (error) throw error
}

// Mapa usuarioId → { puntaje, rubrica_id } para pintar la lista de grupos.
export async function obtenerMapaCalificacionesDocente(
  estudianteIds,
  hemisemestreId
) {
  const mapa = new Map()
  if (estudianteIds.length === 0) return mapa
  const { data, error } = await supabase
    .from('calificaciones_docente')
    .select('estudiante_id, puntaje, rubrica_id')
    .eq('hemisemestre_id', hemisemestreId)
    .in('estudiante_id', estudianteIds)
  if (error) throw error
  data.forEach(row => mapa.set(row.estudiante_id, row))
  return mapa
}

export async function obtenerPendientesDocente(grupos, hemisemestreId) {
  const estudianteIds = grupos.flatMap(g => g.miembros.map(m => m.usuarioId))
  if (estudianteIds.length === 0) return []

  const { data: calificados, error } = await supabase
    .from('calificaciones_docente')
    .select('estudiante_id')
    .eq('hemisemestre_id', hemisemestreId)
    .in('estudiante_id', estudianteIds)
  if (error) throw error

  const yaCalificados = new Set(calificados.map(c => c.estudiante_id))
  const pendientes = []
  grupos.forEach(g =>
    g.miembros.forEach(m => {
      if (!yaCalificados.has(m.usuarioId))
        pendientes.push({ ...m, grupoNumero: g.numero, grupoId: g.id })
    })
  )
  return pendientes
}

// Redondea a 1 decimal (evita errores de coma flotante al sumar).
const redondear1 = valor => Math.round(valor * 10) / 10

export async function obtenerReporteNotasHemisemestre(
  paraleloId,
  hemisemestreId,
  rubricas
) {
  const grupos = await obtenerGruposConDetalle(paraleloId, hemisemestreId)
  const estudiantes = grupos.flatMap(grupo => grupo.miembros)
  const ids = estudiantes.map(estudiante => estudiante.usuarioId)
  const mapaCalificaciones = await obtenerMapaCalificacionesDocente(
    ids,
    hemisemestreId
  )
  const totalEstudiantes = estudiantes.length
  const promediosPorEstudiante = new Map(
    (
      await Promise.all(
        grupos.flatMap(grupo =>
          grupo.miembros.map(async estudiante => [
            estudiante.usuarioId,
            await obtenerPromedioCoeval(
              grupo.id,
              hemisemestreId,
              estudiante.rolGrupo === 'evaluador'
                ? rubricas.coevEvaluador.id
                : rubricas.coevExpositor.id,
              estudiante.usuarioId
            )
          ])
        )
      )
    )
  )

  const filas = []
  const pendientesDocente = []
  const pendientesCoevaluacion = new Map()

  grupos.forEach(grupo => {
    const esperadas = totalEstudiantes - grupo.miembros.length
    grupo.miembros.forEach(estudiante => {
      const esEvaluador = estudiante.rolGrupo === 'evaluador'
      const calificacion = mapaCalificaciones.get(estudiante.usuarioId)
      const maxDoc = esEvaluador
        ? rubricas.docEvaluadorMax
        : rubricas.docExpositorMax
      const rubricaDocente = esEvaluador
        ? rubricas.docEvaluador.id
        : rubricas.docExpositor.id
      const maxCoev = esEvaluador
        ? rubricas.coevEvaluadorMax
        : rubricas.coevExpositorMax
      const promedio = promediosPorEstudiante.get(estudiante.usuarioId)
      const bloqueado = estudiante.coevaluacionBloqueada
      const calificacionValida =
        calificacion?.rubrica_id === rubricaDocente ? calificacion : null
      const docente = calificacionValida
        ? redondear1((Number(calificacionValida.puntaje) / maxDoc) * 70)
        : null
      // Se usa el promedio actual aunque no todos hayan coevaluado aún.
      // Si el docente bloqueó su coevaluación, este componente vale 0.
      const coevaluacion = bloqueado
        ? 0
        : promedio && promedio.cantidad > 0
          ? redondear1((promedio.promedio / maxCoev) * 30)
          : null

      if (!calificacionValida) pendientesDocente.push(estudiante.nombre)
      if (
        !bloqueado &&
        esperadas > 0 &&
        (!promedio || promedio.cantidad < esperadas)
      ) {
        pendientesCoevaluacion.set(grupo.id, {
          grupoNumero: grupo.numero,
          faltantes: esperadas - (promedio?.cantidad ?? 0)
        })
      }

      filas.push({
        nombre: estudiante.nombre,
        usuarioId: estudiante.usuarioId,
        grupoNumero: grupo.numero,
        rol: esEvaluador ? 'Evaluador' : 'Expositor',
        coevaluacionBloqueada: bloqueado,
        docente,
        coevaluacion,
        final:
          docente !== null && coevaluacion !== null
            ? redondear1(docente + coevaluacion)
            : null
      })
    })
  })

  return {
    filas,
    pendientesDocente,
    pendientesCoevaluacion: [...pendientesCoevaluacion.values()],
    totalEstudiantes
  }
}

// ---- Coevaluaciones ----

export async function obtenerResumenCoevaluacionEstudiantes(
  paraleloId,
  hemisemestreId
) {
  const [grupos, matriculas] = await Promise.all([
    obtenerGruposConDetalle(paraleloId, hemisemestreId),
    supabase
      .from('matriculas')
      .select(
        'usuario_id, usuarios!matriculas_usuario_id_fkey(nombre_completo, email)'
      )
      .eq('paralelo_id', paraleloId)
      .then(({ data, error }) => {
        if (error) throw error
        return data ?? []
      })
  ])

  const grupoPorEstudiante = new Map()
  grupos.forEach(grupo => {
    grupo.miembros.forEach(miembro => {
      grupoPorEstudiante.set(miembro.usuarioId, grupo)
    })
  })

  const estudiantesPorId = new Map()
  matriculas.forEach(matricula => {
    estudiantesPorId.set(matricula.usuario_id, {
      usuarioId: matricula.usuario_id,
      nombre: matricula.usuarios?.nombre_completo ?? '(sin nombre)',
      email: matricula.usuarios?.email ?? ''
    })
  })
  grupos.forEach(grupo => {
    grupo.miembros.forEach(miembro => {
      estudiantesPorId.set(miembro.usuarioId, {
        usuarioId: miembro.usuarioId,
        nombre: miembro.nombre,
        email: estudiantesPorId.get(miembro.usuarioId)?.email ?? ''
      })
    })
  })

  // Grupos habilitados con al menos un integrante que pueda coevaluarse.
  const gruposActivos = grupos
    .filter(grupo => grupo.coevaluacionHabilitada)
    .map(grupo => ({ ...grupo, miembros: miembrosCoevaluables(grupo) }))
    .filter(grupo => grupo.miembros.length > 0)

  const estudiantes = [...estudiantesPorId.values()]
  const resumen = await Promise.all(
    estudiantes.map(async estudiante => {
      const grupoPropio = grupoPorEstudiante.get(estudiante.usuarioId)
      const gruposPendientes =
        gruposActivos.filter(grupo => grupo.id !== grupoPropio?.id)
      const detalleGrupos = await Promise.all(
        gruposPendientes.map(async grupo => {
          const coevaluado = await yaCoevaluoGrupo(
            estudiante.usuarioId,
            grupo.id,
            hemisemestreId,
            grupo.miembros.map(miembro => miembro.usuarioId)
          )
          return {
            grupoId: grupo.id,
            numero: grupo.numero,
            tema: grupo.tema,
            coevaluado
          }
        })
      )
      const pendientes = detalleGrupos.filter(grupo => !grupo.coevaluado)
      return {
        ...estudiante,
        grupoNumero: grupoPropio?.numero ?? null,
        grupoId: grupoPropio?.id ?? null,
        gruposActivos: detalleGrupos,
        gruposEvaluados: detalleGrupos.filter(grupo => grupo.coevaluado),
        gruposPendientes: pendientes,
        terminado: pendientes.length === 0
      }
    })
  )

  return resumen.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}

export async function yaCoevaluoGrupo(
  evaluadorId,
  grupoId,
  hemisemestreId,
  estudianteIds = null
) {
  const { data, error } = await supabase
    .from('coevaluaciones')
    .select('estudiante_evaluado_id')
    .eq('evaluador_id', evaluadorId)
    .eq('grupo_evaluado_id', grupoId)
    .eq('hemisemestre_id', hemisemestreId)
  if (error) throw error
  if (!estudianteIds) return (data ?? []).length > 0
  const evaluados = new Set(
    (data ?? []).map(fila => fila.estudiante_evaluado_id)
  )
  return estudianteIds.every(id => evaluados.has(id))
}

// Integrantes ya coevaluados por un evaluador en un hemisemestre.
// Devuelve Map grupoId → Set(estudianteEvaluadoId).
export async function obtenerEvaluadosPorGrupo(evaluadorId, hemisemestreId) {
  const { data, error } = await supabase
    .from('coevaluaciones')
    .select('grupo_evaluado_id, estudiante_evaluado_id')
    .eq('evaluador_id', evaluadorId)
    .eq('hemisemestre_id', hemisemestreId)
  if (error) throw error
  const mapa = new Map()
  ;(data ?? []).forEach(fila => {
    const evaluados = mapa.get(fila.grupo_evaluado_id) ?? new Set()
    evaluados.add(fila.estudiante_evaluado_id)
    mapa.set(fila.grupo_evaluado_id, evaluados)
  })
  return mapa
}

export async function guardarCoevaluacion({
  evaluadorId,
  grupoId,
  hemisemestreId,
  evaluaciones
}) {
  const filas = evaluaciones.map(evaluacion => ({
      evaluador_id: evaluadorId,
      grupo_evaluado_id: grupoId,
      hemisemestre_id: hemisemestreId,
      estudiante_evaluado_id: evaluacion.estudianteEvaluadoId,
      rubrica_id: evaluacion.rubricaId,
      respuestas: evaluacion.respuestas,
      puntaje: evaluacion.puntaje,
      actualizado_en: new Date().toISOString()
    }))
  const { error } = await supabase.from('coevaluaciones').upsert(filas, {
    onConflict:
      'evaluador_id,grupo_evaluado_id,hemisemestre_id,estudiante_evaluado_id,rubrica_id'
  })
  if (error) throw error
}

export async function obtenerPromedioCoeval(
  grupoId,
  hemisemestreId,
  rubricaId,
  estudianteId
) {
  const { data, error } = await supabase.rpc('obtener_coeval_promedio', {
    p_grupo_id: grupoId,
    p_hemisemestre_id: hemisemestreId,
    p_rubrica_id: rubricaId,
    p_estudiante_id: estudianteId
  })
  if (error) throw error
  const fila = data?.[0]
  if (!fila || fila.cantidad === 0) return null
  return { promedio: Number(fila.promedio), cantidad: Number(fila.cantidad) }
}
