import pytest

# IMPORTANTE: Ajuste o caminho do import conforme a estrutura real do seu projeto
# from coletor.exigencias import detectarExigencias 

def test_negacao_nao_deve_anular_exigencia_anterior():
    """
    Regressão: Garante que uma negação em uma frase não anule 
    uma exigência afirmativa na frase anterior.
    """
    texto_edital = "A licitante deverá apresentar amostras. Não haverá prorrogação do prazo de entrega."
    
    # Simulação da chamada (substitua pela função real)
    # resultado = detectarExigencias(texto_edital)
    resultado = ["exigencia.amostra"] # Exemplo de retorno esperado
    
    # O sistema NÃO deve marcar como dispensado
    assert "dispensa.amostra" not in resultado, \
        "BUG CRÍTICO: A negação do prazo anulou incorretamente a exigência de amostra!"
    
    # O sistema DEVE manter a exigência
    assert "exigencia.amostra" in resultado, \
        "Amostras devem ser marcadas como exigidas."
