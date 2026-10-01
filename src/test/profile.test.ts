import { describe, expect, it } from 'vitest'
import { splitName } from '../Settings'

describe('profilo: nome e cognome', () => {
  it('usa quelli separati del servizio di identità quando ci sono', () => {
    expect(splitName({ name: 'Mario De Luca', givenName: 'Mario', familyName: 'De Luca' })).toEqual({ first: 'Mario', last: 'De Luca' })
    expect(splitName({ name: 'Anna', givenName: 'Anna' })).toEqual({ first: 'Anna', last: '' })
  })

  it('senza quelli separati divide il nome completo all’ultima parola', () => {
    expect(splitName({ name: 'Anna Maria Rossi' })).toEqual({ first: 'Anna Maria', last: 'Rossi' })
    expect(splitName({ name: 'Anna' })).toEqual({ first: 'Anna', last: '' })
    expect(splitName({})).toEqual({ first: '', last: '' })
    expect(splitName(null)).toEqual({ first: '', last: '' })
  })
})
